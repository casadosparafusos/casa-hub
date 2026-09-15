# ROADMAP — Casa HUB

## FASE 0 — Runtime audit READ-ONLY — P0 — PARTIAL

Objetivo:
certificar o que está realmente rodando.

- provider preço;
- systemd;
- settings;
- DB;
- CISS;
- Wake;
- promoção;
- tabela;
- intervalos;
- logs;
- uma instância do worker.

Sem writes.

Status: provider live e systemd confirmados (`audit/fase-0-runtime-readonly`, `464c429`/`8448372`). O restante (reconciliação Wake ao vivo) foi coberto pelas fases seguintes.

## FASE 1 — Guards de produção — P0

- impedir mock → Wake;
- settings com Zod por chave;
- GET settings autenticado;
- lock owner-aware;
- tick serial;
- health/ready.

## FASE 2 — Wake readback + reconciliação — P0 — Executado READ-ONLY 1× em produção (11/09/2026, `c7616d7`)

- leitura preço Wake;
- leitura estoque Wake por SKU/CD;
- tabela de preço readback;
- reconciliação full;
- VERIFIED/MISMATCH;
- CSV/JSON de divergências.

Resultado em `PRODUCTION_RECONCILIATION.md` / `RECONCILIATION_READONLY.md`. Sem escrita na Wake; nada foi corrigido.

## FASE 3 — Unit engine — P0 — implementado + hardening em `feat/unit-strategies` (14–15/09/2026), aguardando revisão/merge

Censo READ-ONLY completo (22323 produtos, 13 siglas) em `CISS_UNIT_MAP.md`. Mapa canônico confirmado pelo proprietário:

- preservar UNIT CISS (nunca inferir por nome);
- `CT` → `HundredUnitStrategy`;
- `PC UN JG PR CJ RL KT CX LT PL` → `DirectUnitStrategy`;
- `KG`, `MT` → `MeasuredPackageUnitStrategy` (`CONFIGURATION_REQUIRED` sem `quantity_per_sale_unit`);
- qualquer UNIT futura fora do mapa → `UnsupportedUnitStrategy` (fail closed);
- schema/migrations para `product_sale_unit_config` (ver FASE 7);
- Decimal para dinheiro.

**Implementado na branch `feat/unit-strategies`**: módulo puro `scripts/reconcile/units/` (resolver/strategies/commercial-policy/compute), reexportado para o app via `src/lib/units/index.ts`; `sync/engine.ts` delega `syncPrices()`/`syncStock()` a `calculateUnitPrice()`/`calculateUnitStock()`; UNIT observada persistida em `sync_product_state` (`unit_raw`/`unit_normalized`/`unit_class`/`unit_resolution_status`); schema `product_sale_unit_config` criada (migration `0003_unit_strategies_schema.sql`). **FASE B.1 (hardening, 15/09/2026)**: integridade de `product_sale_unit_config` provada contra banco real (FK/unicidade/CHECK — gap conhecido em `source_unit`, sem CHECK no SQL); testes de fronteira de precisão monetária; prova de fail-closed pra UNIT sem registro; compatibilidade CT confirmada sem lacuna. **Ainda não mergeado, não deployado, não aplicado em produção** — motor de produção (`main`) continua tratando `CT`/PC/KG com a fórmula antiga até o merge e deploy explícitos. Os 16 produtos PC mal-rotulados e o produto KG atuais na Wake ao vivo **não foram corrigidos** (fora de escopo desta fase).

## FASE 4 — Política comercial — P0 — implementado em `feat/unit-strategies` (14/09/2026), configurável via settings na FASE B.1 (15/09/2026), aguardando revisão/merge

- separar normalização de política (arquitetura já descrita em `ARCHITECTURE_TARGET.md`) — **feito**: `commercial-policy.ts` separado de `strategies.ts`;
- `FIXADOR_CENTO` (só produtos `CT`, nunca acoplada por padrão a UNIT futura):
  - +20% varejo;
  - >=100: -20% sobre varejo;
  - 10% de exposição de estoque;
  - ~~valores ainda hardcoded~~ — **resolvido na FASE B.1**: `getCommercialPolicyConfig()` em `settings.ts` (`WHOLESALE_DISCOUNT_PERCENT` novo), com fallback pros mesmos defaults; threaded em `sync/engine.ts`, `pricing/engine.ts`, `inventory/engine.ts` e no reconciliador READ-ONLY;
- validação 1/99/100/101 — coberta em `commercial-policy.test.ts`;
- validar promoção/tabela Wake — **não fez parte desta fase** (nenhuma escrita real na Wake).

## FASE 5 — Histórico sustentável — P1

- `sync_status`;
- heartbeat;
- scheduler não depende de no-op history;
- no-change sem item;
- no-op automático sem lote histórico;
- cleanup legado com backup + dry-run.

## FASE 6 — Operação por SKU — P1

- search;
- paginação;
- single-SKU price/stock/both;
- simulação;
- toggle whitelist.

## FASE 7 — Embalagens KG/MT — P1 — schema pronta em `feat/unit-strategies`; UI/CRUD ainda PENDENTE

- Caixas → Embalagens (`KG` e `MT`, não só KG) — **feito** (motor);
- tabela genérica `product_sale_unit_config` (campos: `managed_product_id, wake_sku, source_unit, quantity_per_sale_unit, active, created_at, updated_at, updated_by`) — **feito**, migration `0003_unit_strategies_schema.sql`, não aplicada em produção; integridade (FK/unicidade/CHECK) provada contra banco real na FASE B.1 — gap conhecido: `source_unit` sem CHECK/enum no SQL, só no tipo TS (sem impacto funcional, motor falha closed antes); **sem camada de acesso/CRUD ou UI própria ainda** — hoje só é populável direto no banco;
- UI: rótulo `QT KG` ou `QT MT` conforme `source_unit` — **pendente**;
- preview — **pendente**;
- status configuração (`CONFIGURATION_REQUIRED` quando ausente/inválido) — **feito** no motor (`calculateUnitPrice`/`calculateUnitStock`), sem exposição na UI ainda;
- preço da unidade de venda — **feito** no motor;
- estoque da unidade de venda — **feito** no motor.

### Importação por planilha (roadmap, não implementar antes desta fase)

- KG: `SKU | NOME | QT KG`; MT: `SKU | NOME | QT MT`;
- validar contra a UNIT real do CISS (rejeitar SKU com UNIT incompatível, SKU ausente, quantidade <= 0; reportar duplicados);
- fluxo: upload → preview → validação → válidos/inválidos → confirmação → import → relatório → audit log;
- a modelagem de `product_sale_unit_config` criada nesta fase não pode bloquear esta importação futura.

## FASE 8 — Dashboard realtime — P1

- SSE;
- progresso;
- Última verificação;
- Última atualização;
- Ambiente Produção;
- saúde;
- tabela só de runs relevantes.

## FASE 9 — Configurações/segurança — P1/P2

- cards por sistema/regra;
- tokens separados;
- roles;
- login rate limit;
- HTTPS.

## FASE 10 — CI/release — P0

- typecheck;
- unit;
- integration;
- build;
- GitHub Actions;
- backup;
- deploy;
- smoke;
- reconciliation;
- rollback.

## Regra

Uma fase lógica por branch/PR.
Não criar mega-branch.
