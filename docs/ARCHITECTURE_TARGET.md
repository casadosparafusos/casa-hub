# ARCHITECTURE_TARGET — Casa HUB v2

## Fluxo

CISS Adapter
→ Whitelist
→ UnitResolver
→ UnitNormalizer
→ CommercialPolicy
→ ExpectedWakeState
→ DiffEngine
→ WakeWriter
→ WakeReadback
→ Verification
→ Persistence
→ UI/SSE

## UnitResolver

Fonte única:
`CISS stock.unit`

Mapa canônico OWNER_CONFIRMED em 11/09/2026 (`CISS_UNIT_MAP.md`):

```text
CT                                     -> HundredUnitStrategy
PC UN JG PR CJ RL KT CX LT PL          -> DirectUnitStrategy
KG                                     -> MeasuredPackageUnitStrategy(KG)
MT                                     -> MeasuredPackageUnitStrategy(MT)
qualquer UNIT futura fora do mapa      -> UnsupportedUnitStrategy (fail closed)
```

Nomeação deliberada: **não** existe `PieceStrategy` — o grupo `DIRECT` inclui JG/PR/CJ/RL/CX, que não são semanticamente "peça"; por isso `DirectUnitStrategy`. Uma UNIT nova e desconhecida nunca vira `DirectUnitStrategy` por padrão — cai em `UnsupportedUnitStrategy`.

## Separação de preço

`UnitNormalizer` (normalização matemática, por UNIT):
- `CT` (HUNDRED): `ciss_price / 100`
- `PC UN JG PR CJ RL KT CX LT PL` (DIRECT): `ciss_price`
- `KG` / `MT` (PACKAGE_MEASURED): `ciss_price_por_unidade_origem * quantity_per_sale_unit`

`CommercialPolicy` (separada da normalização — nunca no adapter CISS):
- `FIXADOR_CENTO` (só para produtos `CT`): varejo +20%; >=100 unidades: desconto 20% sobre varejo; exposição de estoque 10%.
- `DIRECT`: sem regra extra por padrão.
- `PACKAGE_MEASURED`: sem regra extra por padrão.

## Estoque

`CT` (HUNDRED), normalização + política FIXADOR_CENTO:
`floor(raw*100*0.10)`

`PC UN JG PR CJ RL KT CX LT PL` (DIRECT):
`floor(max(raw,0))`

`KG` / `MT` (PACKAGE_MEASURED):
`floor(max(raw,0)/quantity_per_sale_unit)`

## Reconciliation

A reconciliação nunca usa `lastApplied*` como substituto da Wake.

`ExpectedWakeState` deve ser comparado com `WakeLiveState`.

## Persistência

Separar:
- `managed_products`;
- estado atual por produto;
- UNIT observada;
- `product_sale_unit_config` (genérica para KG e MT — não uma tabela por UNIT — campos: `managed_product_id, source_unit, quantity_per_sale_unit, active, created_at, updated_at, updated_by`; SKU nunca denormalizado aqui — resolvível só via JOIN com `managed_products`. **Criada em `feat/unit-strategies` (migration `0003_unit_strategies_schema.sql`), reformulada na FASE B.2 (migration `0004_public_betty_brant.sql`: remove `wake_sku`, adiciona CHECK de `source_unit`), não aplicada em produção**). Integridade provada contra banco real: FK, índice único parcial (`active=1`) e CHECK `quantity_per_sale_unit > 0` (FASE B.1) e CHECK `source_unit IN ('KG','MT')` (FASE B.2) funcionam no nível do banco, não só no tipo TypeScript;
- scheduler/heartbeat;
- runs relevantes;
- itens alterados/falhos/divergentes;
- audit log.

## Single-SKU

O mesmo core deve aceitar:
- lista inteira;
- conjunto de IDs;
- 1 managed product.

Não duplicar regra em uma rota especial.

## Roteamento comercial — Tabela de Preço 74 vs atacarejo nativo Wake (FASE B.4, 16/09/2026)

Três mecanismos comerciais distintos, nunca confundir:

```text
1. preço base/varejo do produto        -- endpoint padrão de preço da Wake
2. Tabela de Preço 74                  -- mecanismo próprio deste app (precoDe fictício)
3. atacarejo/promoção por quantidade   -- mecanismo nativo da Wake (listaAtacado / promoção 10365)
```

**Gate da Tabela 74** (`src/lib/sync/engine.ts`, `syncPrices()`, linha ~409): os writers `addWakePriceTableProducts`/`updateWakePriceTableProducts` só são chamados quando `priceResult.policy === 'FIXADOR_CENTO'` — nunca apenas porque `WAKE_PRICE_TABLE_ID` está configurado, e nunca apenas porque `unitClass === 'HUNDRED'` (um `CT` pode navegar como `policy: 'NONE'` via `commercialPolicyOverride`, ver `resolveCommercialPolicy` em `src/lib/units/policy-resolver.ts`). `policy` é a única fonte de verdade — `UnitPriceResult.policy` (`src/lib/pricing/engine.ts`), originada em `computeUnit()`.

Rotas por UNIT (escopo atual):

```text
CT + FIXADOR_CENTO      -> participa da Tabela 74
DIRECT                  -> NÃO participa
PACKAGE_MEASURED (KG)   -> NÃO participa
PACKAGE_MEASURED (MT)   -> NÃO participa
CT + NoCommercialPolicy -> NÃO participa
```

O `precoDe` da Tabela 74 é **fictício** (`retailPrice * 1.30`, constante `TABLE_FAKE_DISCOUNT_PERCENT` em `sync/engine.ts`) e fica isolado a esse mecanismo — nunca entra no payload base enviado a `updateWakePrices`.

**Semântica de `expectedWholesalePrice`** (`UnitPriceResult.expectedWholesalePrice`, `src/lib/pricing/engine.ts`, renomeado de `wholesalePrice` na FASE B.4): valor de atacado **esperado/calculado pelo domínio** para produtos `FIXADOR_CENTO`, usado hoje só para auditoria/comparação futura — **nenhum caminho de escrita real (`sync/engine.ts`) o publica na Wake nesta fase**. Colunas legadas no banco (`calculatedWakeSpecialPrice`, `lastAppliedWakeSpecialPrice`) mantêm o nome antigo de propósito (renomear exigiria migration sem ganho imediato nesta rodada) — tratá-las como legado, não como fonte de verdade do domínio.

O comportamento real de atacarejo (>=100 unidades) hoje depende inteiramente do que já está configurado na Wake nativamente (promoção 10365 e/ou `listaAtacado`) — **não** do `expectedWholesalePrice` calculado aqui. Isso será validado READ-ONLY na FASE C, nunca escrito nesta fase.

**Mecanismos nativos Wake — referência arquitetural (sem writes)**:
- endpoint de preço base (`updateWakePrices`): preço/estoque padrão por SKU;
- Tabela de Preço (`getWakePriceTableProducts`/`add`/`updateWakePriceTableProducts`, ID 74 neste ambiente): mecanismo específico deste app, usa `precoDe`/`precoPor`, gatilhado só por `policy === 'FIXADOR_CENTO'`;
- `listaAtacado` no produto Wake (`precoPor` + `quantidade`) e consulta específica de atacarejo por produto — mecanismo nativo de tier de quantidade, **não escrito por este app**;
- Storefront `prices.wholesalePrices` — exposição pro cliente final do atacarejo nativo, **não escrito por este app**;
- promoção 10365 (`WAKE_PROMOTION_ID`): hoje só usada como settings/gate de UI, **nunca referenciada em write real**; semântica completa (condição 4, ação 2, escopo) ainda `UNVERIFIED` (ver `RECONCILIATION_READONLY.md`) — não alterada nesta fase.

### Pendência explícita FASE D (READ-ONLY, antes de qualquer remediation/write)

Renomeada de "FASE C" (nome usado nesta seção antes de 17/09/2026) para não colidir com a FASE C real (guards de produção + read-after-write + estados, ver seção abaixo) — decisão explícita do pedido que abriu a FASE C, que instruiu não tocar na promoção 10365 nesta rodada e adiar esta pendência para a próxima letra.

```text
- ler promoção 10365 (condição/ativo/vigência/percentual/escopo);
- ler atacarejo real (listaAtacado) dos SKUs de controle;
- comparar Storefront prices.wholesalePrices/tier quando aplicável;
- validar checkout 1/99/100/101 em janela aprovada;
- só então decidir remediation/write, com aprovação explícita separada.
```

## FASE C — Guards de produção + read-after-write + estados de aplicação (`feat/write-guards-readback`, 17/09/2026)

Converte o motor de sync (canônico por UNIT, FASE B/B.1–B.4) num caminho de escrita operacionalmente seguro, com um modelo de estados explícito por item e sem nenhuma remediação/deploy nesta rodada. Sem merge, sem migration em produção, sem escrita real em Wake/CISS, sem tocar nos 16 produtos PC/KG reais nem na promoção 10365.

### Modelo de estados por item

```text
DETECTED   -- diff encontrado (ERP != estado esperado no Wake), ainda nada enviado
  → SENT       -- chamada de escrita emitida (PUT/POST Wake)
    → READ BACK  -- reconferência pós-escrita executada (GET SKU / GET Tabela 74 / ACK do próprio PUT)
      → VERIFIED   -- readback confirma o valor enviado            => status 'applied'
      → MISMATCH   -- Wake aceitou a escrita, mas o valor lido é outro => status 'mismatch'
      → FAILED     -- a própria chamada de escrita ou a de readback deram erro/não encontraram o item => status 'failed'
```

Estados de bloqueio (nunca chegam a `DETECTED` — recusam a run ou o item antes de qualquer tentativa de escrita):

- `MOCK_PROVIDER_WRITE_BLOCKED` — run inteira recusada antes de criar `sync_runs`, ver abaixo;
- `CONFIGURATION_REQUIRED` / `UNSUPPORTED_UNIT` / `NO_STOCK_RECORD` — por item, já existentes desde a FASE B/B.2 (`unit_resolution_status`), fail-closed antes de qualquer cálculo de preço/estoque.

### MISMATCH vs FAILED — por que a distinção importa

Antes da FASE C, qualquer reconferência que não confirmasse o valor enviado virava `'failed'`, sem diferenciar duas causas bem distintas: "o Wake recusou/não achei o item" (falha de infraestrutura, retry faz sentido) vs. "o Wake aceitou a chamada sem erro, mas o valor lá é outro" (o bug histórico do SKU 7648/syncRunId=172 — sintoma de um bug de contrato ou concorrência, não de rede). A partir da FASE C:

- `'mismatch'`: a chamada de escrita teve sucesso (Wake não devolveu erro) **e** a releitura encontrou o item, mas com um valor diferente do enviado;
- `'failed'`: a própria chamada de escrita deu erro, OU a releitura não encontrou o item / falhou por conta própria (rede, timeout);
- em ambos os casos `lastApplied*` (`sync_product_state`) **não avança** — a próxima run detecta o item como "mudou" de novo e tenta reenviar, em vez de travar num falso "já aplicado".

Aplicado em três pontos de `syncPrices()`/`syncStock()` (`src/lib/sync/engine.ts`): a reconferência de preço unitário (`getWakeProductBySku`), a reconferência da Tabela de Preço 74 (`fetchPriceTableEntries`, ver abaixo) e, desde a FASE C.1, a reconferência de estoque (`readWakeStockByVariantId`, ver seção "FASE C.1" abaixo). **Nota histórica**: até a FASE C, estoque usava só o ACK do próprio `PUT /produtos/estoques` (`produtosAtualizados`/`produtosNaoAtualizados`) e permanecia `'applied'`/`'failed'` sem estado `'mismatch'`, por não existir releitura real — isso mudou na FASE C.1.

### Read-after-write da Tabela de Preço 74

Lacuna real identificada na auditoria que abriu a FASE C: `updateWakePriceTableProducts`/`addWakePriceTableProducts` (`src/lib/wake/client.ts`) devolvem `void` — sem ACK por item, diferente do preço unitário (GET `/produtos/{sku}`) e do estoque (ACK do próprio PUT). Sem nenhuma leitura pós-escrita, uma falha silenciosa do Wake nesse caminho (aceitar a chamada sem aplicar) nunca seria detectada — exatamente a classe de bug já comprovada no preço unitário (SKU 7648). Corrigido reaproveitando o mesmo `fetchPriceTableEntries(priceTableId)` já usado pra montar o diff no topo de `syncPrices()`: após `updateWakePriceTableProducts`/`addWakePriceTableProducts` retornarem sem erro, a tabela inteira é relida e cada item do lote é comparado (`precoPor`/`precoDe`) contra o valor alvo antes de decidir `applied`/`mismatch`/`failed`.

### Guard `MOCK_PROVIDER_WRITE_BLOCKED`

`runSyncLocked()` (`src/lib/sync/engine.ts`) recusa a run inteira — antes de criar qualquer linha em `sync_runs`, mesmo posicionamento do check de `REQUIRED_UNCONFIRMED_KEYS` — quando `getActivePriceProvider().name === 'mock'` e `dryRun` é `false`, independente de `kind` (`price`/`stock`/`both`). Um provider de preço mockado é sinal de ambiente não pronto pra produção como um todo, não uma questão isolada de preço; `dryRun: true` continua permitido com o provider mockado (nenhuma escrita acontece de qualquer forma).

### Idempotência

Já garantida estruturalmente antes da FASE C pelas comparações `priceUnchanged`/`stockUnchanged`/`tableUnchanged` (que evitam reenviar um valor que já bate com o ERP) — a FASE C adiciona apenas a prova de que isso se sustenta ponta a ponta rodando `runSync()` duas vezes seguidas com a mesma origem, inclusive pelo novo caminho de releitura da Tabela 74: zero chamadas aos 4 writers Wake na segunda run.

### Rate limit e concorrência — escrita + read-after-write (FASE C, §12)

Nenhuma mudança de estratégia de lote nesta fase — a FASE C só adicionou leituras de reconferência aos pontos que já existiam; a tabela abaixo documenta o que já estava implementado e permanece válido:

| Caminho | Lote de escrita | Reconferência | Ritmo |
|---|---|---|---|
| Preço unitário | `WAKE_BATCH_SIZE = 50` por `PUT /produtos/precos` | 1 `GET /produtos/{sku}` por item do lote, **serial** (nunca em paralelo) | `sleep(WAKE_VERIFY_DELAY_MS = 650ms)` após cada item — mantém lote+reconferência combinados bem abaixo dos 120 req/min documentados da Wake |
| Tabela de Preço 74 | `WAKE_BATCH_SIZE = 50` por `PUT`/`POST /tabelaPrecos/{id}/produtos` | 1 `GET /tabelaPrecos/{id}/produtos` paginado por **lote inteiro** (não por item) via `fetchPriceTableEntries()` — mesma função usada pro diff inicial | sem sleep extra por item; o custo por lote já é 1 chamada, não N |
| Estoque | `WAKE_BATCH_SIZE = 50` por `PUT /produtos/estoques` | ACK do próprio PUT decide `'failed'` imediato (rejeitado no lote); para os aceitos, 1 `GET /produtos/{identificador}/estoque` (endpoint oficial dedicado, `tipoIdentificador=ProdutoVarianteId` — ver "FASE C.2" abaixo) por item via `readWakeStockByVariantId()`, **serial** | `sleep(WAKE_VERIFY_DELAY_MS = 650ms)` após cada releitura de item aceito, mesmo ritmo do preço unitário |
| Cliente CISS (`src/lib/ciss/client.ts`) | — (só leitura) | — | `MAX_RETRIES = 3`, backoff exponencial `min(1000·2^(tentativa-1), 8000)` ms; retry em 429/5xx/timeout; erro permanente (4xx≠429) nunca repete |
| Cliente Wake (`src/lib/wake/client.ts`) | — | — | `MAX_RETRIES = 2` (deliberadamente mais conservador que o CISS — ver comentário no topo do arquivo); 429 respeita `Retry-After` do header (default 5s se ausente); 5xx usa backoff fixo `3000ms·tentativa`; **circuito abre** após 5 respostas 429 consecutivas na mesma execução (`consecutiveThrottles`, estado de módulo) e recusa novas chamadas com `WakePermanentError` sem nem tentar a rede — proteção contra o lockout de 1h documentado do token Wake em throttle persistente |

Cobertura de teste do retry/backoff (antes zero, só indireta via mocks de `engine.test.ts`): `src/lib/ciss/client.test.ts` (7 testes) e `src/lib/wake/client.test.ts` (9 testes), incluindo o circuito de throttle da Wake.

## FASE C.1 — Hardening final do read-after-write de estoque, antes do merge do PR #3 (`feat/write-guards-readback`, 17/09/2026)

Fecha o BLOCKER encontrado na revisão de código do Draft PR #3: a reconferência de estoque, único caminho de escrita que ainda dependia só do ACK do writer, sem satisfazer a regra canônica da FASE C ("writer 2xx/ACK != estado remoto verificado"). Mesma branch, sem merge/deploy/migration em produção/escrita real em Wake/CISS/início da FASE D.

### `readWakeStockByVariantId` — novo adaptador READ-ONLY de estoque por variante

`src/lib/wake/client.ts` não tinha, até esta fase, nenhuma forma de reler o estoque de uma variante específica pós-escrita (`getWakeProductBySku` cobre preço, não estoque). `readWakeStockByVariantId(variantId, cdId)` reaproveita o endpoint de listagem/catálogo `GET /produtos` (não o de item único) com um truque de cursor exclusivo-ascendente: `produtoVarianteIdDe: variantId - 1`, `quantidadeRegistros: 1`, `camposAdicionais=Estoque`, `centrosDistribuicao={cdId}`. Valida estritamente que o `produtoVarianteId` do item devolvido bate com o pedido — nunca aceita silenciosamente um produto de um gap de ID adjacente — e devolve `number | null` (`null` = não verificável: resposta vazia, campo `estoque[]` ausente, sem entrada pro CD pedido, ou `estoqueFisico` não-numérico). Erro de rede/protocolo (`WakeTransientError`/`WakePermanentError`, ou qualquer exceção não tratada) propaga em vez de virar `null` — o chamador trata isso como `FAILED`, nunca como `MISMATCH` silencioso.

**Nota (FASE C.2)**: esta implementação baseada no endpoint de listagem (`GET /produtos` + cursor `produtoVarianteIdDe`) foi substituída pelo endpoint oficial dedicado de consulta pontual de estoque — ver seção "FASE C.2" abaixo. O modelo de dois estágios ACK→releitura e a distinção VERIFIED/MISMATCH/FAILED descritos nesta seção permanecem válidos; só o endpoint HTTP e o formato de resposta mudaram.

### Modelo de dois estágios em `syncStock()`

```text
ACK do lote (PUT /produtos/estoques)
  → rejeitado no ack (produtosNaoAtualizados) => FAILED, zero releitura gasta
  → aceito no ack (produtosAtualizados)
      → releitura real via readWakeStockByVariantId()
          → bate com o valor alvo   => VERIFIED  => 'applied',  lastAppliedWakeStock avança
          → valor diferente         => MISMATCH  => 'mismatch', lastAppliedWakeStock NÃO avança
          → releitura lança erro    => FAILED     => 'failed',  lastAppliedWakeStock NÃO avança
```

`stockUnchanged` (comparação `lastAppliedWakeStock === targetWakeStock`) continua checado **antes** de qualquer escrita/releitura — zero I/O quando não há mudança real (`no_change`). `dryRun: true` nunca chama nem o writer nem `readWakeStockByVariantId` (`planned`, `lastAppliedWakeStock` intocado).

Nota de implementação: no catch da releitura, `err instanceof WakeClientError ? err.message : String(err)` — um erro genérico (`new Error(...)`, não `WakeClientError`) passa por `String(err)`, que prefixa `"Error: "` à mensagem (ex.: `"Error: ECONNRESET"`), diferente de um `WakeClientError`, cujo `.message` é usado puro. Comportamento real do código, não bug — os testes de `engine.test.ts` verificam essa formatação exata.

### Auditoria de performance da Tabela 74 — BLOCKER descartado sem mudança de código

A revisão do PR #3 pediu para confirmar que `fetchPriceTableEntries()` (reconferência da Tabela 74, ver seção FASE C acima) relê a tabela inteira 1× por **lote**, não 1× por **SKU alterado** — o segundo padrão seria O(N) chamadas e um BLOCKER de performance real em runs grandes. Teste com 3 SKUs alterados na mesma run prova `1 + ceil(N/50) = 2` chamadas totais a `getWakePriceTableProducts` (1 para o diff inicial + 1 para a releitura pós-escrita do lote inteiro) — confirma o comportamento já documentado na tabela de rate-limit da FASE C ("1 GET paginado por lote inteiro, não por item"), sem qualquer alteração de código de batching.

Nota (revisão Tech Lead PR #4, fix #2/#4, FASE D-PRE): este mecanismo de releitura final por full-scan paginado foi substituído por leitura direcionada por item (`readWakePriceTableByVariantId`), que escala melhor com o número de lotes e isola falha de leitura por item — ver seção "Tabela 74" na FASE D-PRE, abaixo.

### §14 — reconciliador READ-ONLY nunca chama um escritor, confirmado sem código novo

Esta exigência já estava integralmente coberta por `scripts/reconcile/no-write-path.test.ts` (133 testes, pré-existente desde antes da FASE C) — um arquivo de análise estática que lê o código-fonte `.ts` real (não mocks) do reconciliador e do módulo puro `src/lib/units/`, e prova por regex: nenhum verbo HTTP de escrita (`PUT`/`POST`/`PATCH`/`DELETE`) em string literal, `fetch`/`fetchImpl` só chamado dentro de `http.ts`, nenhum import de módulo de domínio da aplicação (cliente Wake, DB, settings, sync) fora da exceção estreita de `src/lib/units` (o próprio motor puro de UNIT, também comprovadamente sem acesso a env/DB/HTTP/filesystem), nenhuma palavra-chave de SQL de escrita/`.run()`/`db.exec()`, SQLite aberto com `readonly: true`+`query_only = ON` e só `SELECT`, nenhuma função de escrita de filesystem fora de `output.ts`. Rodado isoladamente nesta fase: 133/133 passando — auditoria confirmada, zero linha de código nova.

Testes: **441 no total** (425 da FASE C + 16 líquidos novos: 6 cenários de estoque A–F, 1 auditoria de performance da Tabela 74, 1 fail-closed consolidado, 1 dry-run consolidado, 7 de `readWakeStockByVariantId` em `client.test.ts`, líquido do ajuste de idempotência). `tsc --noEmit`, `vitest run` (21 arquivos) e `npm run build` limpos.

## FASE C.2 — Corrigir o readback de estoque para o endpoint oficial dedicado da Wake (`feat/write-guards-readback`, 17/09/2026)

Achado de revisão adicional sobre o Draft PR #3, depois de fechado o BLOCKER da FASE C.1: a semântica "ACK do writer != estado remoto verificado" estava correta, mas `readWakeStockByVariantId()` usava o endpoint de **listagem/catálogo** (`GET /produtos` + cursor exclusivo `produtoVarianteIdDe: variantId - 1`) em vez do endpoint **oficial dedicado** de consulta pontual de estoque que a própria documentação Wake recomenda pra esse caso de uso. Mesma branch, sem merge/deploy/migration em produção/escrita real em Wake/CISS/início da FASE D.

### Novo endpoint: `GET /produtos/{identificador}/estoque`

`readWakeStockByVariantId(variantId, cdId)` (assinatura e contrato de retorno `number | null` inalterados — `engine.ts` não precisou de nenhuma mudança) agora chama `GET /produtos/{identificador}/estoque?tipoIdentificador=ProdutoVarianteId`, reaproveitando `wakeRequest()` (mesmo auth/retry/backoff/timeout/circuito de throttle do resto do cliente Wake — nenhum cliente HTTP paralelo). Schema de resposta confirmado ao vivo em 17/09/2026 direto do OAS oficial (`wakecommerce.readme.io`, ver comentário em `src/lib/wake/client.ts` pra URL exata usada):

```json
{
  "estoqueFisico": 0,
  "estoqueReservado": 0,
  "listProdutoVarianteCentroDistribuicaoEstoque": [
    { "centroDistribuicaoId": 0, "nome": "string", "estoqueFisico": 0, "estoqueReservado": 0 }
  ]
}
```

404 devolve texto puro (`"Produto não encontrado"`), não JSON — tratado como não-verificável (`null`), sem retry indevido (`wakeRequest()` só retenta 429/5xx/timeout).

### Semântica do CD e do campo comparado

Os campos `estoqueFisico`/`estoqueReservado` de **topo** são o TOTAL agregado entre todos os CDs — nunca usados para validar a escrita de um CD específico. A seleção é estritamente `centroDistribuicaoId === cdId esperado` dentro de `listProdutoVarianteCentroDistribuicaoEstoque[]`; CD ausente da lista, lista ausente/não-array, ou `estoqueFisico` da entrada não-numérico/não-finito → `null` (nunca `0` silencioso, nunca o total agregado como substituto). Campo comparado: `estoqueFisico` da entrada do CD — auditado contra o writer `updateWakeStock()` (`WakeStockUpdateItem.listaEstoque[]`, que também grava `estoqueFisico` por CD): writer e reader usam exatamente o mesmo campo/semântica, sem necessidade de ajuste. `estoqueReservado` continua nunca subtraído nem comparado — a Wake não expõe um único campo "estoque disponível/exposto"; o que o Casa Hub escreve e verifica é sempre `estoqueFisico`.

### Testes (`client.test.ts`)

Suíte antiga de 7 testes (baseada no endpoint de listagem) substituída por 9 testes cobrindo os 8 cenários mínimos A–H exigidos pela correção (F e G cada um com um caso extra de propagação quando o erro persiste além do retry): request/query corretos (A), CD correto com uma ou várias entradas (B/C), CD ausente → `null` (D), 404 sem retry (E), 429 e 5xx respeitando a política de retry existente, com sucesso após retentativa e com propagação quando o erro persiste (F/G), e campo de estoque malformado (lista ausente, entrada sem `estoqueFisico`, tipo não-numérico) → fail-closed em todos os casos (H). `engine.test.ts` não precisou de nenhuma mudança — os cenários A–F da FASE C.1 (VERIFIED/MISMATCH/FAILED, idempotência, dry-run) e o teste de call-count da Tabela 74 continuam passando sem alteração, porque mockam `readWakeStockByVariantId` no nível de export do módulo, desacoplados do endpoint HTTP subjacente.

### Rate limit — sem mudança de estratégia

O endpoint dedicado continua sendo 1 GET por item efetivamente aceito no ACK do lote, **serial** (`for` + `await sleep(WAKE_VERIFY_DELAY_MS)` em `syncStock()`, `src/lib/sync/engine.ts`) — mesmo ritmo documentado na tabela de rate-limit acima, só trocando qual endpoint é chamado. `MAX concurrent stock readbacks = 1`.

Testes: **443 no total** (441 da FASE C.1 + 2 líquidos: suíte de `readWakeStockByVariantId` em `client.test.ts` cresceu de 7 pra 9 cenários, restante do arquivo idêntico). `tsc --noEmit`, `vitest run` (21 arquivos) e `npm run build` limpos.

## FASE D-PRE — Hardening estático pré-produção, achados de auditoria independente do Tech Lead (`fix/preprod-static-hardening`, 18/09/2026)

FASE D.0 (rollout real: CD 25, tabela 74, promoção 10365) ficou BLOCKED por Auto Mode impedir SSH/exec remoto pro host de produção (`10.0.247.6`) e por ausência de credenciais reais CISS/Wake no ambiente local. O Tech Lead passou a auditar diretamente o repositório público e encontrou blockers estáticos anteriores ao rollout. Branch sobre `main` (`5d94b9b`, já com FASE C/C.1/C.2 mergeadas via PR #3). Escopo só código+testes+documentação — sem produção, SSH, deploy, migration em produção, escrita real Wake/CISS, correção dos 16 PC, remediação de KG ou alteração da promoção 10365.

### Tabela 74 — releitura pós-escrita direcionada por item, sem segundo full-scan (revisão Tech Lead PR #4, fixes #2 e #4)

Histórico nesta mesma fase: a primeira correção (registrada abaixo, revisão anterior do PR #3) tirou a releitura de DENTRO do loop de cada lote de escrita, mas ainda fazia uma ÚNICA releitura **paginada da tabela inteira** ao final — total de leituras por run limitado a 2 (1 diff inicial + 1 verificação final), independente do número de lotes. Uma segunda rodada de revisão do Tech Lead (mesmo PR #4) encontrou dois problemas nesse desenho: (1) essa releitura final não estava em `try/catch` — uma falha de rede/429/5xx na chamada paginada de verificação propagava um erro não tratado e podia derrubar a run inteira depois de todos os lotes já terem sido escritos com sucesso; e (2) o volume de leituras ainda crescia com o tamanho da tabela (P páginas), não com o número de itens efetivamente alterados — para uma tabela grande com poucas mudanças, a verificação lia páginas inteiras de itens que não mudaram.

Corrigido: cada item escrito com sucesso agora é reconferido por uma leitura **direcionada** (`readWakePriceTableByVariantId(variantId, tableId)`, `GET /produtos/{variantId}?tipoIdentificador=ProdutoVarianteId&camposAdicionais=TabelaPreco` em `src/lib/wake/client.ts`), serializada com o mesmo pacing usado na verificação de preço unitário (`WAKE_VERIFY_DELAY_MS = 650`, um item por vez — nunca paralelo). Cada leitura roda em `try/catch` isolado por item: falha da própria releitura (rede/429/5xx/timeout/`variantId` inválido/entrada ausente) sempre vira `'failed'`, nunca `'mismatch'` — `'mismatch'` só quando a leitura tem sucesso e devolve um valor genuinamente diferente do esperado (mesma regra `SENT -> READ BACK -> VERIFIED | MISMATCH | FAILED` do estoque, FASE C.1). Nenhum item que falhar na releitura derruba os demais nem a run inteira.

Fórmula de requests por run: 1 leitura paginada inicial (P GETs, para o diff) + N leituras direcionadas serializadas (1 GET por item efetivamente escrito) — nunca mais um segundo full-scan (P GETs adicionais) como na versão anterior. Para tabelas grandes com poucas mudanças isso é estritamente menos requests; testes dedicados em `engine.test.ts` cobrem sucesso, mismatch e cada modo de falha da releitura direcionada (rede, 429/5xx, timeout, `variantId` ausente/inválido, entrada ausente na resposta).

### Dry-run passou a mostrar o plano da Tabela 74

Antes, a leitura de `tableEntries` (o diff da Tabela 74) só rodava fora de dry-run (`!dryRun && priceTableId !== null`), então `dryRun:true` pulava a Tabela 74 inteira e o preview de segurança nunca detectava nenhuma divergência de `special_price` antes de uma escrita real. Como a leitura é estritamente `GET` (nunca `POST`/`PUT`), ela passou a rodar independente de `dryRun`; em modo dry-run, cada divergência encontrada é registrada com status `'planned'` (sem chamar nenhum dos escritores da Tabela 74).

### Validação de faixa das settings comerciais no servidor

`validateSettingValue()` (`src/lib/settings.ts`) ganhou faixas exatas por chave para as 12 settings numéricas conhecidas (`UNIT_PRICE_MARKUP_PERCENT`, `WHOLESALE_DISCOUNT_PERCENT`, `STOCK_PERCENT`, `WHOLESALE_MIN_QTY`, `RECONCILIATION_HOUR_LOCAL`, `STOCK_SYNC_INTERVAL_MINUTES`, `PRICE_SYNC_INTERVAL_HOURS`, `CISS_STOCK_ENTERPRISE`, `CISS_STOCK_LOCATION`, `WAKE_CD_ID`, `WAKE_PRICE_TABLE_ID`, `WAKE_PROMOTION_ID`), chamada tanto no `PUT /api/settings` (rejeita com 400 antes de persistir) quanto na leitura usada pelo motor de sync real (um valor já persistido fora de faixa — ex.: editado direto no banco — bloqueia o sync do mesmo jeito que bloquearia se estivesse ausente, nunca aplica um valor fora de faixa). Ausente continua caindo no default documentado. 46 testes novos (`src/lib/settings.test.ts`).

### `WAKE_STOCK_CONTROL_MODE` valida `fstore`|`erp`; `CSV_IDENTIFIER_TYPE` removida (revisão Tech Lead PR #4, fix #3)

`WAKE_STOCK_CONTROL_MODE` é textual (não cai nas faixas numéricas de `SETTING_RANGES` acima) e antes aceitava qualquer string não-vazia — um typo no admin (ex.: `"fstroe"`) passava a validação e o motor de sync tratava silenciosamente como se fosse `'erp'` (fail-open, mesma classe de bug que a validação numérica já corrigia do lado dos números). Nova estrutura paralela `SETTING_ENUM_RANGES`/`validateEnumSettingValue()`/`isValidEnumSettingValue()` em `src/lib/settings.ts` — hoje só com `WAKE_STOCK_CONTROL_MODE: ['fstore', 'erp']` — valida exatamente esse conjunto (case-insensitive na entrada, sempre persistindo o valor canônico em minúsculo e trimado), tanto em `checkRequiredUnconfirmed()` (presente-mas-inválido bloqueia sync real igual a ausente) quanto no `PUT /api/settings` (400 antes de persistir, nunca grava o texto bruto digitado).

Auditoria separada confirmou que `CSV_IDENTIFIER_TYPE` (decisão de enviar SKU vs ID interno nas chamadas de escrita do Wake) não tem nenhum consumidor real: `tipoIdentificador` é sempre um literal hardcoded por chamada em `src/lib/wake/client.ts`, nunca lido dessa setting. Removida de `REQUIRED_UNCONFIRMED_KEYS` (agora 4 chaves, não 5), da lista de campos obrigatórios em `src/app/(app)/configuracoes/page.tsx` e do docblock de `src/lib/db/schema.ts`. Testes: suíte de `checkRequiredUnconfirmed()` em `settings.test.ts` reescrita para 4 chaves e para o novo caso presente-e-inválido; testes novos dedicados para `validateEnumSettingValue`/`isValidEnumSettingValue` (`settings.test.ts`) e para o `PUT /api/settings` com `WAKE_STOCK_CONTROL_MODE` válido/canonicalizado/inválido (`route.test.ts`).

### Espaços em branco nas settings numéricas (revisão Tech Lead PR #4, fix #5)

`validateSettingValue()` chamava `Number(raw)` direto — `Number(' 15 ')` funciona (`15`), então um valor com espaço nas pontas passava na validação, mas se algum consumidor futuro comparasse a string persistida em vez de passar por `Number()` de novo, o espaço quebraria a comparação. Corrigido: `raw.trim()` roda antes de `Number()`, e uma string só-de-espaços (`'   '`) agora lança `SettingValidationError` (nunca vira `0`/`NaN` silencioso). Achado um segundo bug relacionado ao aplicar a correção: `PUT /api/settings` validava o valor trimado via `validateSettingValue()`, mas persistia a string ORIGINAL não-trimada (`value`, não o resultado do trim) — `' 15 '` era aceito e ia pro banco com o espaço, apesar da validação em si estar correta. Corrigido junto: a rota agora persiste `value.trim()` para settings numéricas (mesmo `valueToPersist` canônico usado pelo caminho de enum do fix #3, acima). Testes novos em `settings.test.ts` (trim antes de validar/parsear, rejeição de só-espaços) e em `route.test.ts` (`' 15 '` -> `200` e persiste `'15'`; `'   '` -> `400`, nada persistido).

### `GET /api/settings` exige sessão

Rota estava respondendo sem autenticação — não vazava valor de segredo em texto puro (segredos são write-only/criptografados, `secrets.CHAVE` só devolve `true`/`false`), mas expunha config operacional (faixas, chaves obrigatórias, quais segredos estão setados) sem controle de acesso algum. Passou a usar `requireSessionIdentity()`, o mesmo guard das demais rotas autenticadas — 401 sem sessão válida. 10 testes novos (`src/app/api/settings/route.test.ts`, primeira suíte de rota de API do projeto, chamando `GET`/`PUT` exportados direto).

### Retry de falha de rede real no cliente Wake

`wakeRequest()` (`src/lib/wake/client.ts`) já retentava timeout/`AbortError` e 429/5xx com backoff. Uma falha de rede de verdade (DNS, conexão recusada, socket caindo no meio) chega como `TypeError` do `fetch()` — um tipo diferente, que antes caía direto no `throw` final sem nenhuma tentativa nova. Passou a entrar no mesmo caminho de retry, respeitando `MAX_RETRIES=2`; `WakePermanentError` (4xx exceto 429) continua nunca retentado. 3 testes novos em `client.test.ts`.

### Lock só pode ser liberado pelo dono, com token único por aquisição (revisão Tech Lead PR #4, fix #1)

`ownerTag()` (`src/lib/sync/lock.ts`) passou a incluir um nonce gerado por `randomUUID()` a cada chamada — antes, o "dono" do lock era identificável só por `pid`/hostname, então duas aquisições sequenciais pelo mesmo processo (ex.: um retry rápido após uma liberação) podiam colidir em teoria no mesmo identificador de dono. Agora cada `acquireLock()` devolve um token verdadeiramente único por aquisição, e `releaseLock()` só limpa a linha do lock se o token recebido bater exatamente com o dono atual gravado no banco — um `releaseLock()` tardio (ex.: de uma aquisição antiga já expirada por TTL ou cujo PID morreu, e cujo lock outro processo já roubou) vira no-op em vez de derrubar o lock do dono novo. `src/lib/sync/lock.test.ts` (13 testes) cobre acquire/release básico, roubo por TTL expirado, roubo por PID de dono morto, `withLocks()`, `recoverWorkerOrphans()` e, como cenário central, a corrida que o nonce resolve: dono A adquire, lock passa a dono B via TTL expirado/PID morto, e o `releaseLock()` tardio de A (com o token antigo) vira no-op, deixando B intocado como dono.

### Comentários de estoque desatualizados corrigidos

Docblock de `updateWakeStock()` e comentário de verificação de ACK em `syncStock()` (`src/lib/sync/engine.ts`) ainda descreviam o mecanismo de leitura da FASE C.1 (`GET /produtos` de listagem + cursor) como se fosse o atual — desde a FASE C.2 o mecanismo real é o endpoint dedicado `GET /produtos/{identificador}/estoque`. Reescritos para descrever o mecanismo vigente; achado puramente estático, sem impacto em runtime.

Testes: **542 no total, 24 arquivos** (514 da primeira rodada desta fase + 28 líquidos novos dos fixes #1/#2/#3/#4/#5 desta segunda rodada de revisão do Tech Lead no PR #4). `tsc --noEmit`, `vitest run` e `npm run build` limpos. Não mergeado, não deployado, nenhuma migration aplicada em produção, nenhuma escrita real em Wake/CISS. FASE D real de rollout continua BLOCKED por SSH/credenciais.

## Realtime

POST manual:
- cria/agenda run;
- retorna runId;
- trabalho continua;
- UI acompanha por SSE.

## Health

- `/healthz`: processo vivo;
- `/readyz`: DB/worker/config básica pronta;
- health operacional detalhado autenticado.
