# CHANGELOG — documentação

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
