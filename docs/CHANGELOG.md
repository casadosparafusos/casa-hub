# CHANGELOG — documentação

## v9 — 16/09/2026

FASE B.4 (`feat/unit-strategies`): correção final de roteamento comercial antes do Draft PR. Mesma branch, sem merge/deploy/migration em produção/escrita real em Wake/CISS/alteração semântica da promoção 10365. Ver detalhes em `STATUS.md` e `ARCHITECTURE_TARGET.md` (seção "Roteamento comercial").

Mudanças:
- **BLOQUEIO PRINCIPAL**: `syncPrices()` (`src/lib/sync/engine.ts`) tinha o gate da Tabela de Preço 74 como `if (tableEntries)` — disparava os writers `addWakePriceTableProducts`/`updateWakePriceTableProducts` pra qualquer produto só porque `WAKE_PRICE_TABLE_ID` estava configurado, vazando o mecanismo de `FIXADOR_CENTO` pra DIRECT/KG/MT por acidente. Corrigido para `if (tableEntries && priceResult.policy === 'FIXADOR_CENTO')` — `policy` é a decisão comercial centralizada (`resolveCommercialPolicy`), nunca `unitClass === 'HUNDRED'` isolado (um `CT` sem policy override também não participa);
- `UnitPriceResult.policy` (novo campo, `src/lib/pricing/engine.ts`): antes calculado por `computeUnit()` e descartado na fronteira do `pricing/engine.ts` — agora propagado e é a única fonte de verdade consumida pelo gate acima;
- 5 cenários obrigatórios do writer da Tabela 74 cobertos por testes de integração reais com spies do Wake client (`src/lib/sync/engine.test.ts`): CT+FIXADOR_CENTO (pré-existente, confirmado correto), DIRECT (corrigido), KG com config válida (corrigido), MT com config válida (novo), CT+NoCommercialPolicy (novo, simulado via mock direcionado de `calculateUnitPrice` já que ainda não existe campo de override por produto no banco);
- `UnitPriceResult.wholesalePrice` renomeado para `expectedWholesalePrice` (domínio) — deixa explícito que é valor esperado/calculado, nunca efetivamente publicado na Wake nesta fase; colunas legadas do banco (`calculatedWakeSpecialPrice`, `lastAppliedWakeSpecialPrice`) mantidas de propósito (renomear exigiria migration sem ganho imediato), documentadas como legado;
- 401 testes no total (398 da FASE B.3 + 3 novos: 1 em `pricing/engine.test.ts` — CT+NoCommercialPolicy —, 2 em `sync/engine.test.ts` — MT com config e CT+NoCommercialPolicy —; os testes DIRECT e KG foram corrigidos/reescritos, não somam à contagem líquida); typecheck e build limpos; zero drift de `origin/main`;
- **não mergeado, não deployado, nenhuma migration aplicada em produção, nenhuma escrita real em Wake/CISS, promoção 10365 não alterada**.

## v8 — 16/09/2026

FASE B.2 (`feat/unit-strategies`): final hardening, fecha os 5 bloqueios (A-E) apontados na revisão do relatório da FASE B.1. Mesma branch, sem merge/deploy/migration em produção/escrita real em Wake/CISS. Ver detalhes em `STATUS.md`.

Mudanças:
- **BLOQUEIO A**: `product_sale_unit_config.source_unit` ganhou CHECK real em SQL (`IN ('KG','MT')`), não só no tipo TS — migration `drizzle/0004_public_betty_brant.sql`;
- **BLOQUEIO B**: coluna `wake_sku` removida de `product_sale_unit_config` (denormalizada, podia divergir sem erro) — mesma migration; SKU só resolvível via JOIN com `managed_products`;
- **BLOQUEIO C**: novo teste de integração de escrita real (`dryRun:false`) pra PACKAGE_MEASURED (KG) com config ativa, provando por regex no payload que nenhuma chave de atacado/promoção/tabela-74-fixador vaza fora de produtos `CT`;
- **BLOQUEIO D**: `src/lib/units/decimal.ts` — `moneyRound` reescrito (notação exponencial em string em vez de `Number.EPSILON`); corrige bug real (`10.075` virava `10.07`, devia virar `10.08`); 12 testes de fronteira em `decimal.test.ts` (7 exigidos + negativo + casos adicionais);
- **BLOQUEIO E**: `sync/engine.ts` — `syncStock()` intercepta `row?.noRecord` antes do cálculo, gravando `unit_resolution_status: 'NO_STOCK_RECORD'` (novo valor de enum) em vez do caminho morto `NO_RECORD_NOTE`;
- revalidados os 4 nomes/defaults de `CommercialPolicyConfig` (`UNIT_PRICE_MARKUP_PERCENT`, `WHOLESALE_DISCOUNT_PERCENT`, `STOCK_PERCENT`, `WHOLESALE_MIN_QTY` = 20/20/10/100); confirmado que o módulo puro `commercial-policy.ts` nunca importa `settings.ts`; cobertura pré-existente já suficiente, nenhum teste novo necessário;
- 397 testes no total (390 + 7 líquidos novos/ajustados); typecheck e build limpos; zero drift de `origin/main`; zero segredos/artefatos proibidos no diff;
- **não mergeado, não deployado, nenhuma migration aplicada em produção, nenhuma escrita real em Wake/CISS**.

## v7 — 15/09/2026

FASE B.1 (`feat/unit-strategies`): hardening da FASE B, mesma branch. Ver detalhes em `STATUS.md`.

Mudanças:
- `settings.ts`: novo `WHOLESALE_DISCOUNT_PERCENT` (default 20) e `getCommercialPolicyConfig()`, conectando `FIXADOR_CENTO` aos settings (era hardcoded);
- `sync/engine.ts`, `pricing/engine.ts`, `inventory/engine.ts`, `scripts/reconcile-readonly.ts`/`reconcile/*.ts`: passam a receber e usar `commercialPolicyConfig` em vez do default fixo;
- isolamento writer-spy nos testes de integração de `sync/engine.ts`;
- `src/lib/db/product-sale-unit-config.test.ts` (novo): 6 testes de integridade contra SQLite real (FK, índice único parcial, CHECK `quantity_per_sale_unit > 0`); gap confirmado (não corrigido): `source_unit` sem CHECK/enum no banco, só no tipo TS;
- `src/lib/units/decimal.test.ts` (novo, 14 testes) + 2 testes novos em `strategies.test.ts`: fronteiras de precisão monetária (`1.005→1.01`, `2.675→2.68`, `quantity_per_sale_unit` fracionário);
- confirmado: compatibilidade CT (HUNDRED + FIXADOR_CENTO) já coberta por `compute.test.ts`, sem lacuna;
- 390 testes no total (295 + 95 novos/ajustados); typecheck e build limpos;
- **não mergeado, não deployado, nenhuma migration aplicada em produção, nenhuma escrita real em Wake/CISS**.

## v6 — 14/09/2026

FASE B (`feat/unit-strategies`): implementação do motor real de UNIT, sobre o mapa OWNER_CONFIRMED de 11/09/2026. Ver detalhes em `STATUS.md`.

Mudanças:
- módulo puro `scripts/reconcile/units/` (resolver, strategies, commercial-policy, compute), reexportado para o app via `src/lib/units/index.ts`;
- `sync/engine.ts` (`syncPrices()`/`syncStock()`) delega a `calculateUnitPrice()`/`calculateUnitStock()`, com busca única de CISS estoque+unit por run;
- UNIT observada persistida em `sync_product_state`;
- tabela `product_sale_unit_config` criada (migration `0003_unit_strategies_schema.sql`, não aplicada em produção);
- 8 novos testes de integração em `src/lib/sync/engine.test.ts`; 295 testes no total; typecheck e build limpos;
- **não mergeado, não deployado**; os 16 PC mal-rotulados e o produto KG ao vivo na Wake continuam sem correção.

## v5 — 10/09/2026

Consolidação completa após auditoria do repositório público.

Mudanças:
- PRICE_RULES tornou explícita a variação por UNIT;
- CENTO = preço CISS/100;
- fixador varejo = +20%;
- >=100 = -20% sobre o varejo;
- PC/UN = preço CISS por peça;
- KG = preço/kg × kg/caixa;
- estoque CENTO = ×100 e 10%;
- estoque PC/UN = 1:1;
- estoque KG = floor(kg/kgCaixa);
- criado INVENTORY_RULES;
- criado UI_UX_REQUIREMENTS;
- criado REPO_WORKFLOW;
- prompt Claude atualizado para auditoria runtime antes de writes.
