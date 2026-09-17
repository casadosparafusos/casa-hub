# STATUS — Casa Hub

Atualizado em 17/09/2026 (FASE C: guards de produção + read-after-write + estados de aplicação em `feat/write-guards-readback`, sobre `main` já com FASE B/B.1–B.4 mergeadas — Draft PR pendente de abertura — não mergeado, não deployado, nenhuma migration aplicada em produção).

## Produção

- `main` (`c13e7f8`, já com `feat/unit-strategies` mergeada) = o que roda em `10.0.247.6:/opt/erp-wake` (porta 8083, usuário `erpwake`). **Intocado nesta fase.**
- Todo desenvolvimento acontece local e em branches; nada é deployado sem pedido explícito.

## Branches abertas (sem merge)

| Branch | Base | Estado |
|---|---|---|
| `audit/fase-0-runtime-readonly` | main | FASE 0: auditoria de runtime. **PARTIAL**, consolidada em `main` via FASE A/A.1. |
| `audit/reconciliacao-readonly` | main | Reconciliador READ-ONLY. Executado 1× em produção em 11/09/2026 (SHA `c7616d7`). Consolidada em `main` via FASE A/A.1. |
| `audit/ciss-unit-census` | audit/reconciliacao-readonly | Censo READ-ONLY de todas as UNITs do CISS + decisões OWNER_CONFIRMED em 11/09/2026. Consolidada em `main` via FASE A/A.1. |
| `feat/unit-strategies` | `main` (`4ebedec`) | FASE B + B.1–B.4, motor `UnitResolver → UnitStrategy → CommercialPolicy`. **Mergeada em `main` via PR #2 (`c13e7f8`).** |
| `feat/write-guards-readback` | `main` (`c13e7f8`) | **Branch atual (FASE C).** Ver seção dedicada abaixo. |

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
- **Integridade de `product_sale_unit_config`** provada contra banco SQLite real (migrations de produção, `foreign_keys=ON`): FK enforcement, índice único parcial (só `active=1`), CHECK `quantity_per_sale_unit > 0` — todos confirmados no nível do banco, não só por leitura de código. **Gap confirmado, não corrigido nesta fase**: `source_unit` só é restrito a KG/MT no tipo TypeScript, não por CHECK/enum no schema SQL — corrigir exigiria nova migration (fora de escopo; motor falha closed antes de qualquer escrita, então sem impacto funcional hoje). `wake_sku` denormalizado também pode divergir sem erro — sem impacto porque o sync nunca lê esse campo (só `managed_product_id`). **Ambos resolvidos na FASE B.2, ver abaixo.**
- **Precisão monetária**: testes de fronteira dedicados para `moneyRound`/`cleanNumber`/`safeFloor` (`src/lib/units/decimal.test.ts`) e para `computeMeasuredPackage` com `quantity_per_sale_unit` fracionário (2.5, 0.3). Achado registrado nesta fase (revisto na FASE B.2, ver abaixo): `moneyRound` corrigia os casos clássicos de ruído de float `1.005→1.01` e `2.675→2.68` via `+ Number.EPSILON`, mas não foi testado contra o caso `10.075→10.08`.
- **Compatibilidade CT** (HUNDRED + FIXADOR_CENTO): já coberta pelos testes pré-existentes de `compute.test.ts` — nenhuma lacuna encontrada.
- Testes: **390 no total** (295 da FASE B + 95 novos/ajustados de hardening). `tsc --noEmit`, `vitest run` e `npm run build` limpos.

## FASE B.2 — Final hardening — `feat/unit-strategies` (16/09/2026)

Fechamento dos 5 bloqueios (A-E) apontados na revisão do relatório da FASE B.1, sobre a mesma branch, sem merge/deploy/migration em produção/escrita real em Wake/CISS.

- **BLOQUEIO A — CHECK de `source_unit` no banco**: `product_sale_unit_config.source_unit` ganhou `CHECK(source_unit IN ('KG','MT'))` real em SQL (não só no tipo TypeScript), junto com o CHECK pré-existente `quantity_per_sale_unit > 0`. Migration `drizzle/0004_public_betty_brant.sql` (rebuild de tabela SQLite, sem perda de dados além da coluna removida no BLOQUEIO B). Testado contra banco real: valor fora de KG/MT (ex.: `PC` forçado por cast) é rejeitado pelo CHECK mesmo vindo por fora do tipo TS.
- **BLOQUEIO B — remoção de `wake_sku` denormalizado**: coluna removida de `product_sale_unit_config` (mesma migration). O SKU só é resolvível via JOIN com `managed_products` (identidade canônica) — nunca mais pode divergir silenciosamente.
- **BLOQUEIO C — prova de escrita real isolada por UNIT**: novo teste de integração (`dryRun:false`) para PACKAGE_MEASURED (KG) com config ativa, completando a matriz DIRECT/HUNDRED+FIXADOR_CENTO/KG. Prova, por regex no JSON do payload, que nenhuma chave de atacado/promoção/tabela-74-fixador (`wholesale`, `promo`, `10365`) vaza pra fora de produtos `CT`; e que `calculatedWakeSpecialPrice`/`lastAppliedWakeSpecialPrice` continuam `null` fora de HUNDRED.
- **BLOQUEIO D — `moneyRound` reescrito**: a implementação anterior (`Math.round((v + Number.EPSILON) * 100) / 100`) falhava em `10.075 → 10.08` (devolvia `10.07`), porque `10.075 * 100` já arredonda pra `1007.4999...` em IEEE-754 antes do EPSILON compensar. Nova implementação desloca a casa decimal via notação exponencial em string (`Number(v + 'e2')` / `Number(r + 'e-2')`) antes do `Math.round`, evitando o erro de precisão binária da multiplicação por 100. Verificado nos 7 casos de fronteira exigidos + negativo (12 testes em `decimal.test.ts`); suíte completa (397 testes) rodada pra confirmar zero regressão, já que `moneyRound` é usado em toda a engine de preço/estoque.
- **BLOQUEIO E — status distinto pra "sem registro no CISS"**: `syncStock()` agora intercepta `row?.noRecord` antes de chamar `calculateUnitStock`, gravando `unit_resolution_status: 'NO_STOCK_RECORD'` em `sync_product_state` (novo valor no enum, distinto de `UNSUPPORTED_UNIT`) e uma mensagem de erro específica ("Sem registro de estoque no ERP..."), em vez do caminho morto anterior (`NO_RECORD_NOTE`, nunca de fato distinguível de `UNSUPPORTED_UNIT`).
- **Revalidação de `CommercialPolicyConfig`**: confirmados os 4 nomes de settings (`UNIT_PRICE_MARKUP_PERCENT`, `WHOLESALE_DISCOUNT_PERCENT`, `STOCK_PERCENT`, `WHOLESALE_MIN_QTY`), defaults 20/20/10/100, lidos via `getCommercialPolicyConfig()`. Confirmado que `commercial-policy.ts` (módulo puro) nunca importa `settings.ts` diretamente — só `DEFAULT_COMMERCIAL_POLICY_CONFIG` local. Cobertura pré-existente já suficiente (`commercial-policy.test.ts`, `pricing/engine.test.ts`); nenhum teste novo necessário aqui.
- Testes: **397 no total** (390 da FASE B.1 + 7 líquidos novos/ajustados no fechamento dos bloqueios A-E: novo teste real-write BLOQUEIO C, casos de fronteira novos de `moneyRound` no BLOQUEIO D, testes novos de CHECK em `product-sale-unit-config.test.ts` pros BLOQUEIOs A/B, reescrita do teste de `noRecord` no BLOQUEIO E). `tsc --noEmit`, `vitest run` e `npm run build` limpos. Zero drift de `origin/main` (baseline `4ebedec`). Zero segredos/artefatos proibidos no diff da branch.

## FASE B.3 — Auditoria pré-Draft-PR — `feat/unit-strategies` (16/09/2026)

Auditoria de preparação pro Draft PR, mesma branch. Revelou um conflito de arquitetura real (corrigido na FASE B.4, ver abaixo):

- Comprovado que `wholesalePrice` calculado pelo domínio **não** era o mesmo valor efetivamente enviado à Wake (nenhum era enviado — mas o nome do campo sugeria escrita real, sem documentação explícita do contrário).
- Comprovado que a Tabela de Preço 74 recebia `retailPrice` + `precoDe` fictício **genericamente para qualquer UNIT** com `WAKE_PRICE_TABLE_ID` configurado — não apenas para `CT + FIXADOR_CENTO` — violando a regra canônica "DIRECT/KG/MT/CT sem FIXADOR_CENTO não podem herdar mecanismo comercial de fixador por acidente".
- 398 testes no total (397 da FASE B.2 + 1 novo). Typecheck e build limpos.
- **Conclusão**: bloqueio de arquitetura identificado, não corrigido nesta fase — motivou a criação da FASE B.4 (`CASA_HUB_FASE_B4_COMMERCIAL_ROUTING.md`) antes de qualquer Draft PR.

## FASE B.4 — Correção final de roteamento comercial — `feat/unit-strategies` (16/09/2026)

Correção do bloqueio de arquitetura identificado na FASE B.3, mesma branch, sem merge/deploy/migration em produção/escrita real em Wake/CISS/alteração semântica da promoção 10365.

- **BLOQUEIO PRINCIPAL (roteamento da Tabela 74)**: `syncPrices()` (`src/lib/sync/engine.ts`, ~linha 409) tinha o gate `if (tableEntries)` — corrigido para `if (tableEntries && priceResult.policy === 'FIXADOR_CENTO')`. `policy` (novo campo em `UnitPriceResult`, `src/lib/pricing/engine.ts`) é a decisão comercial centralizada (`resolveCommercialPolicy`, `src/lib/units/policy-resolver.ts`) — já calculada por `computeUnit()` mas descartada na fronteira do `pricing/engine.ts` antes desta fase. O gate nunca usa `unitClass === 'HUNDRED'` isoladamente: um `CT` com `commercialPolicyOverride: 'NONE'` também fica fora da Tabela 74.
- **5 cenários obrigatórios do writer da Tabela 74**, todos com spies reais dos writers Wake em `src/lib/sync/engine.test.ts`: `CT+FIXADOR_CENTO` (pré-existente, confirmado correto sem alteração), `DIRECT` (corrigido — antes esperava chamada à Tabela 74, agora prova `not.toHaveBeenCalled()`), `KG` com config válida (corrigido, mesma mudança — a prova por regex de "nenhuma chave de atacado no payload" da FASE B.2/BLOQUEIO C foi superada por uma prova mais forte: a Tabela 74 simplesmente não é chamada), `MT` com config válida (novo), `CT+NoCommercialPolicy` (novo — como ainda não existe campo de override por produto no banco, simulado via mock direcionado de `calculateUnitPrice` que recalcula com `commercialPolicyOverride: 'NONE'`, mantendo o gate de produção real em `sync/engine.ts` como código exercitado).
- Prova de isolamento do `precoDe` fictício (`retailPrice * 1.30`) mantida pelo teste pré-existente `CT+FIXADOR_CENTO`, que já assertava payload de `updateWakePrices` sem `precoDe` vs. payload de `addWakePriceTableProducts` com `precoDe`.
- **Rename de domínio**: `UnitPriceResult.wholesalePrice` → `expectedWholesalePrice` (`src/lib/pricing/engine.ts`), propagado em `sync/engine.ts`. Nenhuma migration nova — colunas legadas do banco (`calculatedWakeSpecialPrice`, `lastAppliedWakeSpecialPrice`) mantidas de propósito, documentadas como legado. Nenhum writer novo de atacarejo criado; promoção 10365 não alterada.
- Documentação: `ARCHITECTURE_TARGET.md` ganhou seção "Roteamento comercial — Tabela de Preço 74 vs atacarejo nativo Wake", incluindo distinção explícita entre preço base / Tabela 74 / atacarejo nativo (`listaAtacado`, Storefront `prices.wholesalePrices`) e a pendência READ-ONLY explícita da FASE C.
- Testes: **401 no total** (398 da FASE B.3 + 3 novos: 1 em `pricing/engine.test.ts` — `CT + NoCommercialPolicy` —, 2 em `sync/engine.test.ts` — MT com config e `CT+NoCommercialPolicy`). `tsc --noEmit`, `vitest run` (19 arquivos, 401/401) e `npm run build` limpos. Zero drift de `origin/main` (baseline `4ebedec`, 11 ahead / 0 behind confirmado nesta fase).
- **§7 — dry-run de elegibilidade à Tabela 74** (`scripts/price-table-74-eligibility-report.ts`, novo): script READ-ONLY local que classifica cada `managed_product` ativo em `ELIGIBLE_PRICE_TABLE_74`/`NOT_ELIGIBLE_PRICE_TABLE_74`, usando o MESMO gate de produção (`priceResult.policy === 'FIXADOR_CENTO'`) a partir da UNIT já persistida em `sync_product_state` (sem chamar CISS/Wake ao vivo, sem remover nenhum vínculo real). Saída por SKU só em `artifacts-private/` (gitignored), nunca commitada — "casa-hub público: nunca versionar dados por SKU". Reaproveita os padrões de `scripts/reconcile/db-readonly.ts` (SQLite `readonly`+`query_only`) e `scripts/reconcile/output.ts` (`assertNoSecrets`, escrita `wx` nunca sobrescreve). **Executado 1× local nesta fase** contra `data/app.db` (banco de dev local, após `npm run db:migrate` local — não é o banco de produção do `10.0.247.6`): retornou 0 produtos ativos, porque o ambiente de dev local nunca rodou uma sincronização real (`managed_products` vazio aqui). Script comprovadamente funcional (roda limpo, sem erros, escreve os 2 artefatos); a classificação com números reais depende de rodar contra uma cópia/leitura do banco de produção, fora de escopo autorizado nesta rodada — fica como próximo passo explícito, não como pendência de código.

## FASE C — Guards de produção + read-after-write + estados de aplicação — `feat/write-guards-readback` (17/09/2026)

Converte o motor canônico por UNIT (FASE B/B.1–B.4, já em `main`) num caminho de escrita operacionalmente seguro: modelo de estados `DETECTED → SENT → READ BACK → VERIFIED` com `MISMATCH`/`FAILED`/`MOCK_PROVIDER_WRITE_BLOCKED` como estados alternativos, mesma branch, sem merge/deploy/migration em produção/escrita real em Wake/CISS. Detalhes completos em `ARCHITECTURE_TARGET.md`, seção "FASE C".

- **Guard `MOCK_PROVIDER_WRITE_BLOCKED`**: `runSyncLocked()` recusa a run inteira (antes de criar `sync_runs`) quando o provider de preço ativo é `mock` e `dryRun` é `false`, pra qualquer `kind`. `dryRun: true` continua liberado com mock.
- **Distinção `MISMATCH` vs `FAILED`** na reconferência de preço unitário e da Tabela 74: `'mismatch'` = Wake aceitou a escrita mas a releitura achou valor diferente (a classe exata do bug histórico do SKU 7648/syncRunId=172); `'failed'` = a escrita ou a própria releitura deram erro/não encontraram o item. Estoque continua só `'applied'`/`'failed'` (ACK binário do PUT, sem "valor diferente" intermediário nesse contrato).
- **Read-after-write da Tabela de Preço 74** (lacuna real, antes inexistente): `updateWakePriceTableProducts`/`addWakePriceTableProducts` devolvem `void`, sem ACK por item — agora a tabela é relida via `fetchPriceTableEntries()` (mesma função do diff inicial) após a escrita, e cada item é comparado antes de `applied`/`mismatch`/`failed`.
- **Teste de idempotência ponta a ponta**: `runSync()` duas vezes seguidas com a mesma origem ERP/Wake não dispara nenhum dos 4 writers Wake na segunda run, incluindo pelo novo caminho de releitura da Tabela 74.
- **Cobertura de retry/backoff** (antes zero, só indireta via mocks de `engine.test.ts`): `src/lib/ciss/client.test.ts` (7 testes) e `src/lib/wake/client.test.ts` (9 testes) — transiente-então-sucesso, esgotamento de tentativas, erro permanente sem retry, token ausente, timeout/AbortError, `Retry-After` da Wake, e o circuito de throttle da Wake (abre após 5×429 consecutivos, recusa sem tentar a rede).
- `syncRunItems.status` ganhou o valor `'mismatch'` no enum TypeScript (`src/lib/db/schema.ts`) — sem CHECK no SQL nesse campo (igual todo o resto do enum), então **sem migration nova**.
- Nenhuma remediação real: os 16 produtos PC mal-rotulados, o produto KG ao vivo e a promoção 10365 continuam **fora de escopo** desta fase (ver `ARCHITECTURE_TARGET.md`, pendência renomeada pra FASE D).
- Testes: **425 no total** (401 pré-existentes da FASE B.4 + 16 novos: 8 em `engine.test.ts` cobrindo os 4 itens acima + 7 em `ciss/client.test.ts` + 9 em `wake/client.test.ts` — total líquido 24). `tsc --noEmit` e `vitest run` (21 arquivos) limpos.

## Pendências conhecidas (aguardando aprovação)

- **CT = CENTO — OWNER_CONFIRMED em 11/09/2026, motor implementado em `feat/unit-strategies`.** Falta: revisão, merge e deploy explicitamente autorizados para a produção parar de ignorar `unit`.
- **9 UNITs antes sem regra (JG, PR, CJ, RL, MT, KT, CX, LT, PL) — OWNER_CONFIRMED como DIRECT** (exceto MT, que é PACKAGE_MEASURED) — **motor implementado**, mesma pendência de merge/deploy acima.
- **Histórico do Git** ainda contém os relatórios por SKU da reconciliação (`95204fd`, `d92f059`). A mitigação é o repositório ficar privado; não houve force-push.
- **16 produtos PC publicados com a fórmula CENTO na Wake** (preço ÷100 ×1,2; estoque ×100 ×10%), quando a regra OWNER_CONFIRMED é DIRECT (1:1). **Ainda não corrigidos** — fora de escopo até merge/deploy autorizados de `feat/unit-strategies`.
- **KG sem `quantity_per_sale_unit`** (SKU 12852) → `CONFIGURATION_REQUIRED`. Schema `product_sale_unit_config` já existe na branch (não aplicada em produção); falta camada de CRUD/UI para popular por produto.
- **Promoção 10365:** falta confirmar a semântica da condição 4 / lógica 3 / `23085` e da ação 2.
- **3 SKUs sem saldo no CISS** (1273, 28875, 28899; o 28875 também sem `retail_price`): pedir ao SIGAS. Desde a FASE B.2 esses produtos caem em `unit_resolution_status: NO_STOCK_RECORD` (status distinto de `UNSUPPORTED_UNIT`), fail-closed, zero escrita — só falta o SIGAS resolver a origem do dado ausente.
- ~~**`FIXADOR_CENTO` com valores hardcoded**~~ — **resolvido na FASE B.1**: agora configurável via settings (`getCommercialPolicyConfig()`), com fallback pros mesmos valores default.
- ~~**`product_sale_unit_config.source_unit` sem CHECK/enum no banco**~~ — **resolvido na FASE B.2**: CHECK `source_unit IN ('KG','MT')` real em SQL (migration `0004_public_betty_brant.sql`), testado contra banco real.
- ~~**`wake_sku` denormalizado em `product_sale_unit_config` podia divergir sem erro**~~ — **resolvido na FASE B.2**: coluna removida; SKU só resolvível via JOIN com `managed_products`.
- **`moneyRound` não tinha prova contra o caso `10.075 → 10.08`** — **resolvido na FASE B.2**: reescrito, verificado contra os 7 casos de fronteira exigidos (+ negativo), suíte completa sem regressão.
