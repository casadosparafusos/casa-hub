# STATUS — Casa Hub

Atualizado em 15/09/2026 (FASE B.1: hardening dos `UnitStrategy` em `feat/unit-strategies`, aguardando revisão do ChatGPT e autorização do usuário — não mergeado, não deployado).

## Produção

- `main` (`4ebedec`) = o que roda em `10.0.247.6:/opt/erp-wake` (porta 8083, usuário `erpwake`). **Intocado nesta fase.**
- Todo desenvolvimento acontece local e em branches; nada é deployado sem pedido explícito.

## Branches abertas (sem merge)

| Branch | Base | Estado |
|---|---|---|
| `audit/fase-0-runtime-readonly` | main | FASE 0: auditoria de runtime. **PARTIAL**, consolidada em `main` via FASE A/A.1. |
| `audit/reconciliacao-readonly` | main | Reconciliador READ-ONLY. Executado 1× em produção em 11/09/2026 (SHA `c7616d7`). Consolidada em `main` via FASE A/A.1. |
| `audit/ciss-unit-census` | audit/reconciliacao-readonly | Censo READ-ONLY de todas as UNITs do CISS + decisões OWNER_CONFIRMED em 11/09/2026. Consolidada em `main` via FASE A/A.1. |
| `feat/unit-strategies` | `main` (`4ebedec`) | **Branch atual (FASE B + FASE B.1).** Implementa o motor `UnitResolver → UnitStrategy → CommercialPolicy` (mapa OWNER_CONFIRMED), integra `sync/engine.ts` (`syncPrices()`/`syncStock()`) ao motor, persiste a UNIT observada por produto, cria a tabela `product_sale_unit_config`. FASE B.1 (hardening) somou `WHOLESALE_DISCOUNT_PERCENT`/`getCommercialPolicyConfig()` (conecta `FIXADOR_CENTO` aos settings em vez de hardcoded), isolamento writer-spy nos testes de sync, testes de integridade de `product_sale_unit_config` contra banco real, testes de fronteira de precisão monetária e prova de fail-closed pra UNIT sem registro. 390 testes no total, typecheck e build limpos. **Não mergeado. Não deployado. Migration não aplicada em produção.** Os 16 produtos PC mal-rotulados e o produto KG atuais na Wake **não foram corrigidos** (fora de escopo). |

## Censo de UNITs do CISS + mapa canônico OWNER_CONFIRMED — `audit/ciss-unit-census`

- Script `scripts/ciss-unit-census.ts` + `scripts/reconcile/unit-census.ts`; testes em `unit-census.test.ts`; coberto por `no-write-path.test.ts`.
- Endpoint: `GET /products/stock?page=N&per_page=500` (listagem, sem `product_id`). O probe de 1 request deu 200 com paginação.
- **45 páginas, 22323 produtos**, 0 repetidos, 69 s.
- Requests: CISS 46 (1 probe + 45), **Wake 0**. **0 writes**.
- **13 UNITs:**
  - PC 13504;
  - CT 6808;
  - JG 741;
  - PR 516;
  - KG 408;
  - CJ 152;
  - RL 78;
  - MT 76;
  - UN 28;
  - KT 5; CX 5; LT 1; PL 1.
  - Nenhuma variação de caixa ou espaço; nenhuma vazia.
- Whitelist (2318):
  - CT 2298;
  - PC 16;
  - UN 0;
  - KG 1;
  - outras 0;
  - sem registro 3.
- **Mapa canônico OWNER_CONFIRMED em 11/09/2026** (substitui os status CANDIDATE/PROPOSED anteriores; detalhes em [CISS_UNIT_MAP.md](CISS_UNIT_MAP.md)):
  - `CT → HUNDRED` (HundredUnitStrategy). Normalização: `base_unit_price = ciss_price/100`, `physical_units = ciss_stock*100`. Política comercial FIXADOR_CENTO (+20%/−20% atacado, 10% de exposição de estoque) é **separada** da normalização — não vai no adapter do CISS.
  - `PC, UN, JG, PR, CJ, RL, KT, CX, LT, PL → DIRECT` (DirectUnitStrategy): `wake_price = ciss_price`, `wake_stock = floor(max(ciss_stock,0))`. Sem ÷100/×100, sem 10%/markup/atacado de fixadores, sem dedução pelo nome do produto.
  - `KG, MT → PACKAGE_MEASURED` (MeasuredPackageUnitStrategy), com `quantity_per_sale_unit` por SKU (`QT KG` / `QT MT`). Sem configuração válida → `CONFIGURATION_REQUIRED`, zero write.
  - UNIT nova fora do mapa → `UNSUPPORTED_UNIT`, fail closed, nunca vira DIRECT ou HUNDRED por padrão.
- Modelagem recomendada (ainda **não criada**): tabela genérica `product_sale_unit_config` (não uma tabela por UNIT), com roadmap de importação por planilha (KG/MT), validada contra a UNIT real do CISS.
- **Implementação adiada de propósito** para `feat/unit-strategies` (a criar a partir da `origin/main`, só depois de aprovação e merge desta fase de doc/auditoria). Nesta rodada não se mexeu em motor de preço, motor de estoque, sync, Wake client, banco, UI ou scheduler; não se escreveu na Wake; não se corrigiram os 16 PC nem o KG; nenhuma migration foi criada.
- Relatório por produto só em `artifacts-private/ciss-unit-census-20260911.{json,csv}` (fora do Git).

### Consolidação do baseline canônico — `docs/canonical-baseline-unit-map`

Os documentos citados no pedido de censo (`docs/BUSINESS_RULES.md`, `docs/PRICE_RULES.md`, `docs/INVENTORY_RULES.md`, `docs/ARCHITECTURE_TARGET.md`, `docs/ROADMAP.md`, `docs/UI_UX_REQUIREMENTS.md`) não existiam na árvore de `audit/ciss-unit-census`; existiam só em `audit/fase-0-runtime-readonly` (commit `62e54e7`). Nesta branch (`docs/canonical-baseline-unit-map`, criada diretamente de `origin/main`) eles foram trazidos de `audit/fase-0-runtime-readonly` e, num commit seguinte, atualizados para refletir o mapa OWNER_CONFIRMED (`CT→HUNDRED`, `PC/UN/JG/PR/CJ/RL/KT/CX/LT/PL→DIRECT`, `KG/MT→PACKAGE_MEASURED`, UNIT futura→`UNSUPPORTED_UNIT`). `README.md` e `CLAUDE.md` também vieram da FASE 0 e foram atualizados. `STATUS.md`, `CISS_UNIT_MAP.md`, `PRODUCTION_RECONCILIATION.md`, `RECONCILIATION_READONLY.md`, `.gitignore` e os scripts READ-ONLY vieram da versão mais recente em `audit/ciss-unit-census`, que prevalece sobre a de `audit/fase-0-runtime-readonly` onde houver sobreposição.

## Reconciliador READ-ONLY — `audit/reconciliacao-readonly`

Detalhes em [RECONCILIATION_READONLY.md](RECONCILIATION_READONLY.md).

- Script: `scripts/reconcile-readonly.ts`; módulos em `scripts/reconcile/`.
- Compara CISS real → UNIT (campo `unit` do CISS) → regra esperada → Wake real, e grava `reconciliation-YYYYMMDD-HHMM.{json,csv}`.
- **Sem write path:**
  - Wake/CISS só GET;
  - SQLite `readonly` + `query_only`;
  - nenhum import de sync, cliente Wake, settings ou db da aplicação;
  - provado por `no-write-path.test.ts`.
- Rate limit Wake: ≤ 30 req/min, cursor de 50 em `/produtos` com `camposAdicionais=Estoque` em toda página, aborta no primeiro 429/401/403.
- Estoque Wake sem `estoque[]` → `ERROR` (não verificável), nunca `STOCK_MISMATCH` em massa.
- CISS: concorrência 1 por padrão (`--ciss-concurrency` opcional, de 1 a 4).
- Promoção estrita: `PASS` só se provar ativo, vigente, quantidade 100, desconto percentual de 20 e escopo; senão `UNVERIFIED` com o `raw` preservado.
- Testes: 10 arquivos, 164 testes (`scripts/reconcile/*.test.ts`).

### Execução em produção — 11/09/2026 (única)

- SHA `c7616d7`, rodado em `/tmp/reconcile-20260911-1021` como `erpwake`.
- Duração **15 min 13 s**; exit 0.
- Requests: Wake 144 (0 respostas não-2xx), CISS 2334.
- Wake 2318/2318 encontrados; estoque Wake verificável (4800/4800 com `estoque[]`); errors 0.
- UNIT CISS:
  - **CT 2298** (unsupported);
  - PC 16;
  - KG 1;
  - CENTO 0; UN 0; missing 0.
- Comparações (só as linhas PC): preço 0 match / 16 mismatch; estoque 3 / 13; tabela 74 0 / 16.
- CISS_MISSING 3 (1273, 28875, 28899); CONFIGURATION_REQUIRED 1 (KG 12852).
- Promoção 10365: `UNVERIFIED`. A Wake devolve a condição 4 (argumentos 23085 e 100) e a ação 2 (20.00), sem descritor textual nem lista de produtos.
- Relatórios completos (JSON, CSV, plan, log) **só fora do Git**, em `artifacts-private/reconciliation-20260911/` na estação; os originais continuam em `/tmp/reconcile-20260911-1021/` no servidor.
- Simulação informativa: aplicando CENTO às linhas CT, 2297 de 2298 bateriam em preço, tabela e estoque. **Não** é resultado oficial; a regra não foi alterada.

### Correção registrada (borda de ponto flutuante)

A FASE 0 afirmou que a fórmula de estoque de produção (`Math.floor(s*100*0.10)`) poderia perder 1 unidade por ruído de float (ex.: 2,3 → 22). **A afirmação estava errada.** Em JS, `2.3*100*0.1 === 23`, e uma busca exaustiva em todos os valores com até 3 casas decimais entre 0 e 1000 não encontrou nenhuma divergência. O reconciliador ainda usa um `safeFloor` defensivo e marca `floatEdgeNote` se algum valor real divergir. Nenhum valor real divergiu na execução de 11/09.

## FASE B — Unit strategies — `feat/unit-strategies` (14/09/2026)

Implementação do motor real de UNIT, sobre o mapa OWNER_CONFIRMED do censo (11/09/2026). Escopo estritamente de **motor + persistência + testes**, sem deploy, sem merge, sem escrita real em Wake/CISS, sem migration em produção.

- Módulo puro `scripts/reconcile/units/` (`resolver.ts`, `strategies.ts`, `commercial-policy.ts`, `compute.ts`): zero import de Wake/CISS/DB/settings/sync/filesystem/env; reexportado para o app via `src/lib/units/index.ts` (mesmo import-specifier guard do `no-write-path.test.ts`).
- `computeUnit()`: união discriminada (`ok:true`/`ok:false`), motivo de falha `UNSUPPORTED_UNIT` ou `CONFIGURATION_REQUIRED` — nunca exceção para fluxo de negócio; corrupção numérica genuína (preço negativo/NaN, estoque não finito) continua lançando.
- `sync/engine.ts`: `syncPrices()`/`syncStock()` delegam a `calculateUnitPrice()`/`calculateUnitStock()`; busca de estoque+unit no CISS feita **uma única vez por run**, compartilhada entre preço e estoque (mesmo em `kind='price'`, que agora também consulta `/products/stock` por causa da UNIT — consequência aceita, documentada nos testes).
- UNIT observada persistida em `sync_product_state` (`unit_raw`, `unit_normalized`, `unit_class`, `unit_resolution_status`) — nunca mais silenciosamente descartada.
- Tabela `product_sale_unit_config` criada (migration `0003_unit_strategies_schema.sql`) — **sem camada de CRUD/UI ainda**; hoje só populável direto no banco.
- `FIXADOR_CENTO` (política comercial do `CT`) permanece com valores **hardcoded** (`+20%` varejo, `-20%` atacado, `10%` exposição de estoque, `wholesaleMinQty: 100`) — débito técnico pré-existente, sinalizado mas não corrigido nesta fase (`rules`/`ruleSettings` do `settings.ts` ficaram sem efeito nesse caminho).
- Testes: 295 no total (287 pré-existentes + 8 novos de integração de `sync/engine.ts` cobrindo DIRECT/HUNDRED/PACKAGE_MEASURED com e sem config/UNSUPPORTED_UNIT, persistência em `sync_product_state`, busca única de CISS e o invariante `appliedProducts === 0` em dry-run). Typecheck e `npm run build` limpos.
- **Nada disso corrige os 16 produtos PC mal-rotulados nem o produto KG hoje ao vivo na Wake** — motor de produção (`main`) continua na fórmula antiga até merge + deploy explícitos, autorizados separadamente.

## FASE B.1 — Hardening — `feat/unit-strategies` (15/09/2026)

Endurecimento do motor da FASE B, sobre a mesma branch, sem merge/deploy/migration em produção/escrita real em Wake/CISS. Sete pontos auditados:

- **`FIXADOR_CENTO` conectado aos settings**: `settings.ts` ganhou `WHOLESALE_DISCOUNT_PERCENT` (default 20) e `getCommercialPolicyConfig()`, que lê as 4 regras (`UNIT_PRICE_MARKUP_PERCENT`, `WHOLESALE_DISCOUNT_PERCENT`, `STOCK_PERCENT`, `WHOLESALE_MIN_QTY`) com fallback pro valor hardcoded anterior. `sync/engine.ts`, `pricing/engine.ts`, `inventory/engine.ts` e o reconciliador READ-ONLY (`scripts/reconcile-readonly.ts`/`reconcile/*.ts`) passaram a receber e usar essa config em vez do `DEFAULT_COMMERCIAL_POLICY_CONFIG` fixo — resolve o débito técnico sinalizado na FASE B (valores hardcoded, `settings.ts` sem efeito nesse caminho).
- **Isolamento writer-spy** nos testes de integração de `sync/engine.ts` — evita vazamento de estado entre testes.
- **Integridade de `product_sale_unit_config`** provada contra banco SQLite real (migrations de produção, `foreign_keys=ON`): FK enforcement, índice único parcial (só `active=1`), CHECK `quantity_per_sale_unit > 0` — todos confirmados no nível do banco, não só por leitura de código. **Gap confirmado, não corrigido nesta fase**: `source_unit` só é restrito a KG/MT no tipo TypeScript, não por CHECK/enum no schema SQL — corrigir exigiria nova migration (fora de escopo; motor falha closed antes de qualquer escrita, então sem impacto funcional hoje). `wake_sku` denormalizado também pode divergir sem erro — sem impacto porque o sync nunca lê esse campo (só `managed_product_id`).
- **Precisão monetária**: testes de fronteira dedicados para `moneyRound`/`cleanNumber`/`safeFloor` (`src/lib/units/decimal.test.ts`) e para `computeMeasuredPackage` com `quantity_per_sale_unit` fracionário (2.5, 0.3). Achado confirmado (não é bug): `moneyRound` já corrige corretamente os casos clássicos de ruído de float `1.005→1.01` e `2.675→2.68` via `+ Number.EPSILON`.
- **Compatibilidade CT** (HUNDRED + FIXADOR_CENTO): já coberta pelos testes pré-existentes de `compute.test.ts` — nenhuma lacuna encontrada.
- Testes: **390 no total** (295 da FASE B + 95 novos/ajustados de hardening). `tsc --noEmit`, `vitest run` e `npm run build` limpos.

## Pendências conhecidas (aguardando aprovação)

- **CT = CENTO — OWNER_CONFIRMED em 11/09/2026, motor implementado em `feat/unit-strategies`.** Falta: revisão, merge e deploy explicitamente autorizados para a produção parar de ignorar `unit`.
- **9 UNITs antes sem regra (JG, PR, CJ, RL, MT, KT, CX, LT, PL) — OWNER_CONFIRMED como DIRECT** (exceto MT, que é PACKAGE_MEASURED) — **motor implementado**, mesma pendência de merge/deploy acima.
- **Histórico do Git** ainda contém os relatórios por SKU da reconciliação (`95204fd`, `d92f059`). A mitigação é o repositório ficar privado; não houve force-push.
- **16 produtos PC publicados com a fórmula CENTO na Wake** (preço ÷100 ×1,2; estoque ×100 ×10%), quando a regra OWNER_CONFIRMED é DIRECT (1:1). **Ainda não corrigidos** — fora de escopo até merge/deploy autorizados de `feat/unit-strategies`.
- **KG sem `quantity_per_sale_unit`** (SKU 12852) → `CONFIGURATION_REQUIRED`. Schema `product_sale_unit_config` já existe na branch (não aplicada em produção); falta camada de CRUD/UI para popular por produto.
- **Promoção 10365:** falta confirmar a semântica da condição 4 / lógica 3 / `23085` e da ação 2.
- **3 SKUs sem saldo no CISS** (1273, 28875, 28899; o 28875 também sem `retail_price`): pedir ao SIGAS.
- ~~**`FIXADOR_CENTO` com valores hardcoded**~~ — **resolvido na FASE B.1**: agora configurável via settings (`getCommercialPolicyConfig()`), com fallback pros mesmos valores default.
- **`product_sale_unit_config.source_unit` sem CHECK/enum no banco** — só restrito no tipo TypeScript; um valor fora de KG/MT chegando por fora do app (SQL bruto, migração de dados) seria aceito pelo schema. Sem impacto funcional hoje (o motor falha closed antes de qualquer escrita), mas corrigir exigiria nova migration — fora de escopo da FASE B.1.
