# CHANGELOG — documentação

## v12 — 17/09/2026

FASE C.2 (`feat/write-guards-readback`, mesma branch, ainda Draft PR #3): corrige o readback de estoque para usar o endpoint oficial dedicado da Wake em vez do endpoint de listagem/catálogo usado na FASE C.1. Achado de revisão adicional depois de fechado o BLOCKER da FASE C.1 — a semântica ACK≠VERIFIED já estava correta, só o endpoint HTTP era o errado. Branch não mergeada, sem deploy/migration em produção/escrita real em Wake/CISS/início da FASE D. Ver detalhes em `STATUS.md` e `ARCHITECTURE_TARGET.md` (seção "FASE C.2").

Mudanças:
- **Endpoint corrigido**: `readWakeStockByVariantId(variantId, cdId)` (`src/lib/wake/client.ts`) deixou de usar `GET /produtos` (endpoint de listagem/catálogo, com cursor `produtoVarianteIdDe`) e passou a usar `GET /produtos/{identificador}/estoque?tipoIdentificador=ProdutoVarianteId` — o endpoint oficial dedicado de consulta pontual de estoque documentado pela Wake. Assinatura e contrato de retorno (`number | null`) inalterados; `engine.ts` não precisou de nenhuma mudança;
- Schema de resposta confirmado ao vivo em 17/09/2026 direto do OAS oficial (`wakecommerce.readme.io`): `{estoqueFisico, estoqueReservado, listProdutoVarianteCentroDistribuicaoEstoque: [{centroDistribuicaoId, nome, estoqueFisico, estoqueReservado}]}`; 404 devolve texto puro (`"Produto não encontrado"`), sem retry indevido;
- **Seleção do CD**: estritamente `centroDistribuicaoId === cdId esperado` dentro de `listProdutoVarianteCentroDistribuicaoEstoque[]` — nunca o `estoqueFisico`/`estoqueReservado` agregado do topo (total entre todos os CDs), nunca `0` silencioso quando o CD esperado não aparece;
- **Campo comparado auditado contra o writer**: `updateWakeStock()` grava `estoqueFisico` por CD (`WakeStockUpdateItem.listaEstoque[]`) — o reader agora compara o mesmo campo da mesma semântica, sem ajuste necessário; `estoqueReservado` continua nunca subtraído nem comparado;
- **Testes**: suíte antiga de 7 testes (endpoint de listagem) substituída por 9 testes cobrindo os 8 cenários mínimos exigidos (request/query, CD correto com uma/várias entradas, CD ausente, 404 sem retry, 429/5xx com retry e com propagação quando persiste, estoque malformado → fail-closed); `engine.test.ts` não precisou de nenhuma mudança — cenários A–F da FASE C.1 e call-count da Tabela 74 continuam passando sem alteração;
- **Rate limit**: sem mudança de estratégia — continua 1 GET por item aceito no ACK, serial, `MAX concurrent stock readbacks = 1`, mesmo `WAKE_VERIFY_DELAY_MS = 650ms`;
- 443 testes no total (441 da FASE C.1 + 2 líquidos: suíte de `readWakeStockByVariantId` cresceu de 7 pra 9 cenários); `tsc --noEmit` e `vitest run` (21 arquivos) limpos; `npm run build` limpo;
- **não mergeado, não deployado, nenhuma migration aplicada em produção, nenhuma escrita real em Wake/CISS, FASE D não iniciada**.

## v11 — 17/09/2026

FASE C.1 (`feat/write-guards-readback`, mesma branch da FASE C, sobre `main` já com `feat/unit-strategies` mergeada via PR #2, `c13e7f8`): hardening final antes do merge do PR #3, corrigindo o BLOCKER encontrado na revisão do código (estoque confirmava só pelo ACK do PUT, não por releitura real) e auditando o risco de leitura N× da Tabela 74. Branch não mergeada, sem deploy/migration em produção/escrita real em Wake/CISS/início da FASE D. Ver detalhes em `STATUS.md` e `ARCHITECTURE_TARGET.md` (seção "FASE C", subseção de estoque atualizada).

Mudanças:
- **BLOQUEIO PRINCIPAL corrigido — read-after-write real de estoque**: a reconferência de estoque dependia só do ACK do próprio `PUT /produtos/estoques` ("binário via ACK"), o que a revisão do PR #3 apontou como não satisfazendo a regra canônica da FASE C ("writer 2xx/ACK != estado remoto verificado"). Agora, pra cada item aceito no ACK do lote, uma releitura real via `readWakeStockByVariantId()` (novo, `src/lib/wake/client.ts`) confirma o valor contra a Wake antes de `applied`; item aceito no ACK mas com valor diferente na releitura vira `'mismatch'` (não `'failed'`) — o estoque ganha a mesma distinção `MISMATCH`/`FAILED` que preço e Tabela 74 já tinham; `lastAppliedWakeStock` só avança no ramo `VERIFIED`;
- `readWakeStockByVariantId(variantId, cdId)` (`src/lib/wake/client.ts`): usa o endpoint de listagem `GET /produtos` com cursor exclusivo (`produtoVarianteIdDe: variantId-1`, `quantidadeRegistros: 1`), valida que o `produtoVarianteId` devolvido bate exatamente com o pedido (nunca aceita item de gap de ID), devolve `number | null`; erro de rede/protocolo propaga (o chamador trata como `'failed'`, nunca como `'mismatch'` silencioso); 7 testes novos em `client.test.ts`;
- **6 cenários obrigatórios de estoque** (`src/lib/sync/engine.test.ts`, novo describe): A) ack aceito + releitura confirma → `applied`, `lastAppliedWakeStock` avança; B) ack aceito + releitura acha valor diferente → `mismatch`, `lastAppliedWakeStock` não avança; C) Wake recusa no ack do lote → `failed`, zero releitura gasta; D) ack aceito + releitura lança erro de rede → `failed` (nunca `mismatch`), com nota de que erro genérico (não `WakeClientError`) passa por `String(err)` e ganha prefixo `"Error: "`; E) estoque já igual ao último aplicado → `no_change`, zero chamada a escritor ou releitura; F) dry-run com estoque divergente → `planned`, zero escritor/releitura real;
- **Auditoria de performance da Tabela 74 — BLOCKER descartado**: revisão do PR #3 pediu para confirmar que `fetchPriceTableEntries()` relê a tabela inteira 1× por lote, não 1× por SKU alterado. Novo teste com 3 SKUs alterados na mesma run prova exatamente `1 + ceil(N/50) = 2` chamadas totais a `getWakePriceTableProducts` (1 diff inicial + 1 releitura pós-escrita de todo o lote) — nunca `N` chamadas. Nenhum código de batching foi alterado, só comprovado por teste;
- **teste fail-closed consolidado** (`src/lib/sync/engine.test.ts`, novo describe): `UNSUPPORTED_UNIT` + `CONFIGURATION_REQUIRED` (KG sem config) + `NO_STOCK_RECORD` misturados numa única run — nenhum aciona qualquer um dos 4 writers Wake. Nota de escopo: não existe um código de validação distinto de "preço inválido"/"estoque inválido" no motor (confirmado por busca no código) — o teste foi desenhado em torno dos motivos de recusa que realmente existem (resolução de UNIT), sem inventar caminho de validação novo;
- **teste dry-run consolidado** (`src/lib/sync/engine.test.ts`, novo describe): produto `CT+FIXADOR_CENTO` com preço, estoque e Tabela 74 todos divergentes do estado anterior — `dryRun:true` numa única run prova zero chamada aos 4 writers Wake e `lastApplied*` (preço/especial/estoque) inteiramente intocado;
- **idempotência estendida ao novo caminho de estoque**: o teste ponta a ponta já existente (rodar `runSync()` duas vezes seguidas) ganhou a asserção `mockReadWakeStockByVariantId` não chamado na segunda run, cobrindo o novo readback real junto dos outros 3 writers;
- **§14 confirmado sem código novo**: auditoria confirmou que `scripts/reconcile/no-write-path.test.ts` (133 testes, pré-existente) já prova por análise estática do código-fonte que o reconciliador READ-ONLY e o módulo puro `src/lib/units/` nunca chamam nenhum escritor — nenhum verbo HTTP de escrita, `fetch` só dentro de `http.ts`, nenhum import de módulo de app fora do escopo permitido, nenhum SQL de escrita, SQLite aberto `readonly`+`query_only`, nenhuma escrita de filesystem fora de `output.ts`. Rodado isoladamente, 133/133 passando — nenhuma linha de código nova foi necessária para fechar este ponto;
- **fix de typecheck em `client.test.ts`** (pré-existente, nunca compilado antes desta rodada): `vi.mocked(fetch).mock.calls[0][0]` disparava `TS2532` (`mock.calls[0]` possivelmente `undefined`) — corrigido com asserção não-nula (`mock.calls[0]![0]`);
- 441 testes no total (425 da FASE C + 16 líquidos novos: 6 cenários de estoque + 1 auditoria de performance da Tabela 74 + 1 fail-closed consolidado + 1 dry-run consolidado + 7 de `readWakeStockByVariantId` em `client.test.ts`, líquido de ajustes na extensão de idempotência); `tsc --noEmit` e `vitest run` (21 arquivos) limpos; `npm run build` limpo;
- **não mergeado, não deployado, nenhuma migration aplicada em produção, nenhuma escrita real em Wake/CISS, FASE D não iniciada**.

## v10 — 17/09/2026

FASE C (`feat/write-guards-readback`, sobre `main` já com `feat/unit-strategies` mergeada via PR #2, `c13e7f8`): guards de produção + read-after-write + estados de aplicação. Branch nova, sem merge/deploy/migration em produção/escrita real em Wake/CISS/remediação dos 16 PC/KG/promoção 10365. Ver detalhes em `STATUS.md` e `ARCHITECTURE_TARGET.md` (seção "FASE C").

Mudanças:
- **Guard `MOCK_PROVIDER_WRITE_BLOCKED`**: `runSyncLocked()` (`src/lib/sync/engine.ts`) recusa a run inteira, antes de criar `sync_runs`, quando o provider de preço ativo é `mock` e `dryRun` é `false`, pra qualquer `kind`; `dryRun:true` com mock continua liberado;
- modelo de estados `DETECTED → SENT → READ BACK → VERIFIED`, com `syncRunItems.status` ganhando o valor `'mismatch'` (enum TypeScript em `src/lib/db/schema.ts`, sem CHECK novo no SQL — sem migration) — distinção explícita entre `'mismatch'` (Wake aceitou a escrita, releitura achou valor diferente — a classe do bug histórico do SKU 7648/syncRunId=172) e `'failed'` (erro na escrita ou na própria releitura); aplicado à reconferência de preço unitário e à Tabela 74; estoque permanece `'applied'`/`'failed'` (ACK binário do PUT, sem "valor diferente" possível nesse contrato);
- **read-after-write da Tabela de Preço 74** (lacuna real, antes inexistente): `updateWakePriceTableProducts`/`addWakePriceTableProducts` não devolvem ACK por item — agora a tabela é relida via `fetchPriceTableEntries()` após a escrita, comparando item a item antes de `applied`/`mismatch`/`failed`;
- teste de idempotência ponta a ponta: `runSync()` duas vezes seguidas com a mesma origem não dispara nenhum dos 4 writers Wake na segunda run, incluindo pelo novo caminho de releitura da Tabela 74;
- **cobertura de retry/backoff pra `ciss/client.ts` e `wake/client.ts`** (antes zero, só indireta via mocks de `engine.test.ts`): `src/lib/ciss/client.test.ts` (7 testes) e `src/lib/wake/client.test.ts` (9 testes) — transiente-então-sucesso, esgotamento de `MAX_RETRIES`, erro permanente sem retry, token ausente, timeout/`AbortError`, `Retry-After` da Wake, e o circuito de throttle da Wake (abre após 5×429 consecutivos, recusa sem tentar a rede);
- documentação da estratégia de rate-limit/concorrência já existente em `sync/engine.ts` (`WAKE_BATCH_SIZE=50`, `WAKE_VERIFY_DELAY_MS=650`, releitura serial por item pra preço, releitura em lote único pra Tabela 74, releitura via ACK do PUT sem GET extra pro estoque) — nenhum código de batching/concorrência foi alterado, só documentado;
- renomeada a antiga pendência "FASE C" (leitura READ-ONLY da promoção 10365/atacarejo nativo/checkout, em `ARCHITECTURE_TARGET.md` e `ROADMAP.md`) para **FASE D**, pra não colidir com o nome usado pelos guards de produção desta rodada — decisão de documentação, nenhum adapter novo escrito, conforme a própria instrução do pedido que abriu esta fase;
- 425 testes no total (401 da FASE B.4 + 24 líquidos novos: 8 em `engine.test.ts` cobrindo os 4 itens de estado/readback/idempotência acima + 16 de retry/backoff); typecheck limpo;
- **não mergeado, não deployado, nenhuma migration aplicada em produção, nenhuma escrita real em Wake/CISS, os 16 PC mal-rotulados/produto KG/promoção 10365 continuam fora de escopo**.

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
