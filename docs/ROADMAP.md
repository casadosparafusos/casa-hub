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

## FASE 1 — Guards de produção — P0 — parcialmente implementado em `feat/write-guards-readback` (FASE C, 17/09/2026), aguardando revisão/merge

- **impedir mock → Wake — feito**: `runSyncLocked()` (`src/lib/sync/engine.ts`) recusa a run inteira (`MOCK_PROVIDER_WRITE_BLOCKED`) antes de criar `sync_runs` quando `getActivePriceProvider().name === 'mock'` fora de dry-run, pra qualquer `kind`. Ver `ARCHITECTURE_TARGET.md`, seção "FASE C".
- settings com Zod por chave — não fez parte desta rodada;
- GET settings autenticado — não fez parte desta rodada;
- lock owner-aware — pré-existente, não alterado nesta rodada;
- tick serial — pré-existente, não alterado nesta rodada;
- health/ready — não fez parte desta rodada.

**Também na FASE C (fora do escopo original desta linha do roadmap, mas mesma branch)**: modelo de estados `DETECTED → SENT → READ BACK → VERIFIED` com distinção explícita `MISMATCH` (Wake aceitou a escrita, valor releu diferente) vs `FAILED` (erro de fato); read-after-write da Tabela de Preço 74 (lacuna real, antes inexistente); teste de idempotência ponta a ponta; cobertura de retry/backoff pra `ciss/client.ts` e `wake/client.ts` (antes zero). Detalhes completos em `ARCHITECTURE_TARGET.md` e `STATUS.md`. 425 testes no total, typecheck limpo. **Não mergeado, não deployado, nenhuma escrita real em Wake/CISS.**

## FASE 2 — Wake readback + reconciliação — P0 — Executado READ-ONLY 1× em produção (11/09/2026, `c7616d7`)

- leitura preço Wake;
- leitura estoque Wake por SKU/CD;
- tabela de preço readback;
- reconciliação full;
- VERIFIED/MISMATCH;
- CSV/JSON de divergências.

Resultado em `PRODUCTION_RECONCILIATION.md` / `RECONCILIATION_READONLY.md`. Sem escrita na Wake; nada foi corrigido.

## FASE 3 — Unit engine — P0 — implementado + hardening + final hardening + correção de roteamento comercial em `feat/unit-strategies` (14–16/09/2026), aguardando revisão/merge

Censo READ-ONLY completo (22323 produtos, 13 siglas) em `CISS_UNIT_MAP.md`. Mapa canônico confirmado pelo proprietário:

- preservar UNIT CISS (nunca inferir por nome);
- `CT` → `HundredUnitStrategy`;
- `PC UN JG PR CJ RL KT CX LT PL` → `DirectUnitStrategy`;
- `KG`, `MT` → `MeasuredPackageUnitStrategy` (`CONFIGURATION_REQUIRED` sem `quantity_per_sale_unit`);
- qualquer UNIT futura fora do mapa → `UnsupportedUnitStrategy` (fail closed);
- schema/migrations para `product_sale_unit_config` (ver FASE 7);
- Decimal para dinheiro.

**Implementado na branch `feat/unit-strategies`**: módulo puro `scripts/reconcile/units/` (resolver/strategies/commercial-policy/compute), reexportado para o app via `src/lib/units/index.ts`; `sync/engine.ts` delega `syncPrices()`/`syncStock()` a `calculateUnitPrice()`/`calculateUnitStock()`; UNIT observada persistida em `sync_product_state` (`unit_raw`/`unit_normalized`/`unit_class`/`unit_resolution_status`, agora com `NO_STOCK_RECORD` — FASE B.2); schema `product_sale_unit_config` criada (migration `0003_unit_strategies_schema.sql`). **FASE B.1 (hardening, 15/09/2026)**: integridade de `product_sale_unit_config` provada contra banco real (FK/unicidade/CHECK — gap identificado em `source_unit`, sem CHECK no SQL); testes de fronteira de precisão monetária; prova de fail-closed pra UNIT sem registro; compatibilidade CT confirmada sem lacuna. **FASE B.2 (final hardening, 16/09/2026)**: fechou os 5 bloqueios apontados na revisão de B.1 — CHECK real `source_unit IN ('KG','MT')` no banco + remoção de `wake_sku` denormalizado (migration `0004_public_betty_brant.sql`), prova de escrita real isolada por UNIT (DIRECT/HUNDRED/PACKAGE_MEASURED), `moneyRound` reescrito (corrige bug real em `10.075→10.08`), status `NO_STOCK_RECORD` distinto de `UNSUPPORTED_UNIT` pra produto sem saldo no CISS, `CommercialPolicyConfig` revalidada. 397 testes no total. **FASE B.4 (correção de roteamento comercial, 16/09/2026)**: corrigiu o gate da Tabela de Preço 74 em `syncPrices()` — antes disparava pra qualquer produto só porque `WAKE_PRICE_TABLE_ID` existia (vazando o mecanismo de fixador pra DIRECT/KG/MT por acidente); agora exige `priceResult.policy === 'FIXADOR_CENTO'`, nunca `unitClass === 'HUNDRED'` isolado. Campo de domínio renomeado `wholesalePrice` → `expectedWholesalePrice` (deixa explícito que é valor esperado/auditoria, nunca publicado na Wake nesta fase; colunas legadas do banco mantidas). 5 cenários de writer da Tabela 74 cobertos por testes de integração reais (CT+FIXADOR_CENTO, DIRECT, KG, MT, CT+NoCommercialPolicy). Detalhes arquiteturais em `ARCHITECTURE_TARGET.md` (seção "Roteamento comercial"). 401 testes no total. **Ainda não mergeado, não deployado, não aplicado em produção** — motor de produção (`main`) continua tratando `CT`/PC/KG com a fórmula antiga até o merge e deploy explícitos. Os 16 produtos PC mal-rotulados e o produto KG atuais na Wake ao vivo **não foram corrigidos** (fora de escopo desta fase).

## FASE 4 — Política comercial — P0 — implementado em `feat/unit-strategies` (14/09/2026), configurável via settings na FASE B.1 (15/09/2026), aguardando revisão/merge

- separar normalização de política (arquitetura já descrita em `ARCHITECTURE_TARGET.md`) — **feito**: `commercial-policy.ts` separado de `strategies.ts`;
- `FIXADOR_CENTO` (só produtos `CT`, nunca acoplada por padrão a UNIT futura):
  - +20% varejo;
  - >=100: -20% sobre varejo;
  - 10% de exposição de estoque;
  - ~~valores ainda hardcoded~~ — **resolvido na FASE B.1**: `getCommercialPolicyConfig()` em `settings.ts` (`WHOLESALE_DISCOUNT_PERCENT` novo), com fallback pros mesmos defaults; threaded em `sync/engine.ts`, `pricing/engine.ts`, `inventory/engine.ts` e no reconciliador READ-ONLY;
- validação 1/99/100/101 — coberta em `commercial-policy.test.ts`;
- validar promoção/tabela Wake — **não fez parte desta fase** (nenhuma escrita real na Wake);
- **FASE B.4 (16/09/2026)**: Tabela de Preço 74 passou a respeitar a decisão comercial centralizada (`priceResult.policy === 'FIXADOR_CENTO'`) em vez de disparar pra qualquer UNIT com `WAKE_PRICE_TABLE_ID` configurado — ver `ARCHITECTURE_TARGET.md`; validação READ-ONLY da promoção 10365 e do atacarejo nativo da Wake permanece pendência explícita, agora rotulada **FASE D** (renomeada na FASE C pra não colidir com o nome usado pelos guards de produção, ver `ARCHITECTURE_TARGET.md`).

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
- tabela genérica `product_sale_unit_config` (campos: `managed_product_id, source_unit, quantity_per_sale_unit, active, created_at, updated_at, updated_by` — `wake_sku` removida na FASE B.2, SKU só via JOIN com `managed_products`) — **feito**, migration `0003_unit_strategies_schema.sql` + `0004_public_betty_brant.sql` (FASE B.2), não aplicada em produção; integridade (FK/unicidade/CHECK `quantity_per_sale_unit>0` na FASE B.1, CHECK `source_unit IN ('KG','MT')` na FASE B.2) provada contra banco real; **sem camada de acesso/CRUD ou UI própria ainda** — hoje só é populável direto no banco;
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
