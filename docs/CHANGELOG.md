# CHANGELOG — documentação

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
