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

## FASE 1 — Guards de produção — P0 — implementado + hardening final em `feat/write-guards-readback` (FASE C + FASE C.1 + FASE C.2, 17/09/2026) mergeada via PR #3; hardening estático adicional em `fix/preprod-static-hardening` (FASE D-PRE, 18/09/2026), mergeada em `main` via PR #4 (`4a59960d`)

- **impedir mock → Wake — feito**: `runSyncLocked()` (`src/lib/sync/engine.ts`) recusa a run inteira (`MOCK_PROVIDER_WRITE_BLOCKED`) antes de criar `sync_runs` quando `getActivePriceProvider().name === 'mock'` fora de dry-run, pra qualquer `kind`. Ver `ARCHITECTURE_TARGET.md`, seção "FASE C".
- **Tabela 74, releitura pós-escrita direcionada por item, sem segundo full-scan — feito na FASE D-PRE**: uma primeira correção moveu a releitura pra fora do loop de escrita (releitura paginada única no final); uma segunda rodada de revisão do Tech Lead (mesmo PR) substituiu essa releitura final por leitura direcionada por item (`readWakePriceTableByVariantId`, 1 GET por item escrito, serializado) — nunca mais um segundo full-scan da tabela, e cada leitura protegida por `try/catch` isolado (falha vira `'failed'`, nunca `'mismatch'`);
- **dry-run mostra o plano da Tabela 74 — feito na FASE D-PRE**: leitura (`GET`) passou a rodar também em `dryRun:true`, antes o preview pulava a Tabela 74 inteira;
- **settings com validação de faixa por chave — feito na FASE D-PRE**: `validateSettingValue()` (`src/lib/settings.ts`) agora valida faixa exata das 12 settings numéricas conhecidas, tanto no `PUT` quanto na leitura usada pelo sync real; `raw.trim()` roda antes de `Number()` (segunda rodada, fix #5) — só-espaços rejeitado, valor persistido é sempre o trimado;
- **`WAKE_STOCK_CONTROL_MODE` valida `fstore`|`erp`; `CSV_IDENTIFIER_TYPE` removida — feito na FASE D-PRE (segunda rodada, fix #3)**: nova validação de enum rejeita qualquer valor fora de `fstore`/`erp`; `CSV_IDENTIFIER_TYPE` saiu de `REQUIRED_UNCONFIRMED_KEYS` (zero consumidor real confirmado por auditoria); **`erp` bloqueado pra escrita real de estoque — feito na FASE D-PRE (revisão final #2, fix #1)**: `erp` é um valor válido mas o app não implementa baixa de estoque por pedido; `runSyncLocked()` agora recusa a run (`WAKE_STOCK_CONTROL_MODE_UNSUPPORTED_FOR_REAL_STOCK_SYNC`) sempre que `kind` inclui estoque e `dryRun===false` com esse modo — `dryRun:true` e `kind:'price'` não são afetados;
- **GET settings autenticado — feito na FASE D-PRE**: `GET /api/settings` passou a exigir `requireSessionIdentity()`, antes respondia sem autenticação;
- **lock owner-aware com token único por aquisição — feito na FASE D-PRE (segunda rodada, fix #1)**: `randomUUID()`-based nonce em `ownerTag()` é o fix desta rodada (não pré-existente de fase anterior); `src/lib/sync/lock.test.ts`, 13 testes;
- tick serial — pré-existente, não alterado nesta rodada;
- health/ready — não fez parte desta rodada.

**FASE D-PRE (hardening estático pré-produção, 18/09/2026, `fix/preprod-static-hardening`)** — **não confundir com a FASE D real de rollout** (validação da promoção 10365/atacarejo Wake, referenciada na FASE 4 abaixo, que continua BLOCKED por SSH/credenciais). FASE D-PRE é uma fase código-only disparada por auditoria estática independente do Tech Lead direto sobre o repositório público, em três rodadas de revisão no mesmo PR (#4): a primeira cobriu os itens desta lista, mais retry de falha de rede real (`TypeError`) no cliente Wake e correção de 2 comentários desatualizados sobre o mecanismo de leitura de estoque; a segunda rodada (mesmo dia) corrigiu 5 achados adicionais — lock token único (fix #1), releitura final da Tabela 74 em `try/catch` (fix #2), validação enum de `WAKE_STOCK_CONTROL_MODE` + remoção de `CSV_IDENTIFIER_TYPE` (fix #3), leitura direcionada por item na Tabela 74 (fix #4) e trim de espaços nas settings numéricas, incluindo um bug de persistência relacionado no `PUT /api/settings` (fix #5); a terceira rodada — revisão final #2, mesmo dia — corrigiu mais 6 achados: guard fail-closed pra `erp` bloquear escrita real de estoque (fix #1), `try/catch` independente pra UPDATE/ADD da Tabela 74 dentro do mesmo lote (fix #2), teste direto de `readWakePriceTableByVariantId()` (fix #3), teste genuíno multi-lote (fix #4), comentário desatualizado corrigido em `engine.ts` (fix #5), `CSV_IDENTIFIER_TYPE` removida do `.env.example` (fix #6) — mais correção de precisão na documentação sobre `WAKE_STOCK_CONTROL_MODE` e 3 bugs de gates (2 em testes novos, 1 de typecheck) encontrados e corrigidos ao rodar a suíte completa pela primeira vez nesta rodada. Detalhes em `ARCHITECTURE_TARGET.md` (seção "FASE D-PRE") e `STATUS.md`. 560 testes no total. **Mergeada em `main` via PR #4 (`4a59960d`).** Não deployado, nenhuma escrita real em Wake/CISS; não desbloqueia a FASE D real.

**Também na FASE C (fora do escopo original desta linha do roadmap, mas mesma branch)**: modelo de estados `DETECTED → SENT → READ BACK → VERIFIED` com distinção explícita `MISMATCH` (Wake aceitou a escrita, valor releu diferente) vs `FAILED` (erro de fato); read-after-write da Tabela de Preço 74 (lacuna real, antes inexistente); teste de idempotência ponta a ponta; cobertura de retry/backoff pra `ciss/client.ts` e `wake/client.ts` (antes zero). Detalhes completos em `ARCHITECTURE_TARGET.md` e `STATUS.md`. 425 testes no total, typecheck limpo. **Não mergeado, não deployado, nenhuma escrita real em Wake/CISS.**

**FASE C.1 (hardening final, 17/09/2026)** — fechou o BLOCKER da revisão do Draft PR #3: estoque confirmava só pelo ACK do PUT, sem satisfazer a regra "writer 2xx/ACK != estado remoto verificado" da própria FASE C. Novo adaptador `readWakeStockByVariantId()` (`src/lib/wake/client.ts`) confirma o valor real pós-escrita; estoque ganhou a mesma distinção `MISMATCH`/`FAILED` que preço e Tabela 74 já tinham. Também auditou e descartou um possível BLOCKER de performance na Tabela 74 (releitura é 1× por lote, não 1× por SKU) e confirmou, sem código novo, que o reconciliador READ-ONLY nunca chama um escritor (`no-write-path.test.ts`, 133 testes pré-existentes). Detalhes em `ARCHITECTURE_TARGET.md` (seção "FASE C.1") e `STATUS.md`. 441 testes no total. **Não mergeado, não deployado, nenhuma escrita real em Wake/CISS, FASE D não iniciada.**

**FASE C.2 (correção de endpoint, 17/09/2026)** — revisão adicional apontou que `readWakeStockByVariantId()` usava o endpoint de listagem/catálogo (`GET /produtos` + cursor) em vez do endpoint oficial DEDICADO de estoque da Wake (`GET /produtos/{identificador}/estoque?tipoIdentificador=ProdutoVarianteId`). Corrigido: mesma assinatura/contrato de retorno, `engine.ts` sem mudanças, CD selecionado estritamente por `centroDistribuicaoId` dentro de `listProdutoVarianteCentroDistribuicaoEstoque[]` (nunca o total agregado do topo), campo comparado (`estoqueFisico`) auditado contra o writer. Detalhes em `ARCHITECTURE_TARGET.md` (seção "FASE C.2"), `STATUS.md` e `WAKE-API-CONTRATOS.md`. 443 testes no total. **Não mergeado, não deployado, nenhuma escrita real em Wake/CISS, FASE D não iniciada.**

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

## FASE 7 — Embalagens KG/MT — P1 — schema pronta desde `feat/unit-strategies`; CRUD/UI/importação implementados em `feat/measured-packages-admin` (FASE E, 18/09/2026); PR #5 aberto como Draft, `REQUEST_CHANGES` na primeira revisão do Tech Lead, correções em andamento na mesma branch/PR

- Caixas → Embalagens (`KG` e `MT`, não só KG) — **feito** (motor);
- tabela genérica `product_sale_unit_config` (campos: `managed_product_id, source_unit, quantity_per_sale_unit, active, created_at, updated_at, updated_by` — `wake_sku` removida na FASE B.2, SKU só via JOIN com `managed_products`) — **feito**, migration `0003_unit_strategies_schema.sql` + `0004_public_betty_brant.sql` (FASE B.2), não aplicada em produção; integridade (FK/unicidade/CHECK `quantity_per_sale_unit>0` na FASE B.1, CHECK `source_unit IN ('KG','MT')` na FASE B.2) provada contra banco real;
- **camada de CRUD + UI própria — feito na FASE E**: `/embalagens` (`src/app/(app)/embalagens/page.tsx` + `src/components/embalagens/embalagens-client.tsx`), APIs internas autenticadas (`src/app/api/embalagens/{route,[id]/route}.ts`), validação contra a whitelist de `managed_products` e a UNIT real do CISS;
- UI: rótulo `QT KG` ou `QT MT` conforme `source_unit` — **feito na FASE E**;
- preview — **feito na FASE E** (obrigatório antes de aplicar, tanto no CRUD manual quanto na importação por planilha);
- status configuração (`CONFIGURATION_REQUIRED` quando ausente/inválido) — **feito** no motor (`calculateUnitPrice`/`calculateUnitStock`) desde a FASE B; exposto na UI a partir da FASE E;
- preço da unidade de venda — **feito** no motor;
- estoque da unidade de venda — **feito** no motor;
- **migration nova de histórico/auditoria `product_sale_unit_config_events` — feito na FASE E**: registra quem alterou o quê e quando, sem mudar o schema/contrato de `product_sale_unit_config`; não aplicada em produção.

### Importação por planilha — feito em `feat/measured-packages-admin` (FASE E, 18/09/2026)

- KG: `SKU | NOME | QT KG`; MT: `SKU | NOME | QT MT` — **feito** (`.csv` e `.xlsx`, `src/lib/measured-packages/parser.ts`);
- validar contra a UNIT real do CISS (rejeitar SKU com UNIT incompatível, SKU ausente/fora da whitelist/inativo, quantidade <= 0; nunca inferir UNIT pelo nome da aba/arquivo; fórmula de célula nunca lida/executada) — **feito**, `src/lib/measured-packages/service.ts`;
- fluxo: upload → preview → validação → válidos/inválidos → confirmação → import → relatório → audit log — **feito** (preview obrigatório antes de aplicar; audit log é a migration `product_sale_unit_config_events` acima);
- a modelagem de `product_sale_unit_config` desta fase não bloqueou a importação — **confirmado**;
- limites de 5MB e 5000 linhas, parser `server-only` (nunca no bundle client) — **feito**;
- `GET /api/embalagens/template` devolve `.xlsx` de exemplo real — **feito**;
- prova end-to-end com o exemplo canônico (18kg/R$12/180kg → R$216/10 unidades, ponta a ponta via `runSync()`) — **feito**, 3 testes dedicados em `src/lib/sync/engine.test.ts`;
- Testes: 621 no total (560 da FASE D-PRE + 61 líquidos novos da FASE E); `tsc --noEmit`, `vitest run` e `npm run build` limpos. **Não mergeado, não deployado, nenhuma migration aplicada em produção, nenhuma escrita real em Wake/CISS.**

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
