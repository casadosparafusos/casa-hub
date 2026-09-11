# STATUS — Casa Hub

Atualizado em 11/09/2026 (consolidação do baseline canônico: FASE 0 + reconciliador + censo de UNITs + decisões OWNER_CONFIRMED, tudo numa única branch documental).

## Produção

- `main` = `053434c` = o que roda em `10.0.247.6:/opt/erp-wake` (porta 8083, usuário `erpwake`). **Intocado.**
- Todo desenvolvimento acontece local e em branches; nada é deployado sem pedido explícito.

## Branches abertas (sem merge)

| Branch | Base | Estado |
|---|---|---|
| `audit/fase-0-runtime-readonly` | main | FASE 0: auditoria de runtime. **PARTIAL**: provider live e systemd ok; a reconciliação ao vivo foi feita pelo reconciliador (linha abaixo). Consolidada abaixo. |
| `audit/reconciliacao-readonly` | main 053434c | Reconciliador READ-ONLY. **Executado 1× em produção em 11/09/2026 (SHA `c7616d7`)**, só leitura, sem correções. Resultado em [PRODUCTION_RECONCILIATION.md](PRODUCTION_RECONCILIATION.md). Consolidada abaixo. |
| `audit/ciss-unit-census` | audit/reconciliacao-readonly | Censo READ-ONLY de todas as UNITs do CISS **+ decisões de negócio OWNER_CONFIRMED em 11/09/2026.** Resultado em [CISS_UNIT_MAP.md](CISS_UNIT_MAP.md). Consolidada abaixo. |
| `docs/canonical-baseline-unit-map` | **origin/main (053434c)** | **Branch atual.** Reúne numa única base documental coerente: docs canônicos da FASE 0 (`README.md`, `CLAUDE.md`, `BUSINESS_RULES.md`, `PRICE_RULES.md`, `INVENTORY_RULES.md`, `ARCHITECTURE_TARGET.md`, `ROADMAP.md`, `UI_UX_REQUIREMENTS.md`, etc., já atualizados com o mapa OWNER_CONFIRMED) + `STATUS.md`/`CISS_UNIT_MAP.md`/reconciliação/scripts READ-ONLY das branches acima. Candidata a PR (draft) para `main`. Ainda **não implementado** nenhum `UnitStrategy`; motor de produção intocado. |

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

## Pendências conhecidas (aguardando aprovação — nada corrigido)

- **CT = CENTO — OWNER_CONFIRMED em 11/09/2026.** O mapa canônico em [CISS_UNIT_MAP.md](CISS_UNIT_MAP.md) já reflete a decisão. Falta implementar: motor de produção ainda ignora `unit` e aplica CENTO a tudo.
- **9 UNITs antes sem regra (JG, PR, CJ, RL, MT, KT, CX, LT, PL) — OWNER_CONFIRMED como DIRECT** (exceto MT, que é PACKAGE_MEASURED). 1575 produtos no catálogo, 0 na whitelist hoje. Falta implementar.
- **Histórico do Git** ainda contém os relatórios por SKU da reconciliação (`95204fd`, `d92f059`). A mitigação é o repositório ficar privado; não houve force-push.
- **16 produtos PC publicados com a fórmula CENTO na Wake** (preço ÷100 ×1,2; estoque ×100 ×10%), quando a regra OWNER_CONFIRMED é DIRECT (1:1). Confirma que o motor de produção ignora `unit`. A correção fica para `feat/unit-strategies`, fora de escopo até lá.
- **KG sem `quantity_per_sale_unit`** (SKU 12852) → `CONFIGURATION_REQUIRED`. Nenhuma migration criada, de propósito; a modelagem genérica `product_sale_unit_config` ainda não existe.
- **Promoção 10365:** falta confirmar a semântica da condição 4 / lógica 3 / `23085` e da ação 2.
- **3 SKUs sem saldo no CISS** (1273, 28875, 28899; o 28875 também sem `retail_price`): pedir ao SIGAS.
