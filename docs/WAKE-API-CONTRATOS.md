# Contratos da Wake Commerce (Fbits) Admin API usados nesta integração

Fonte: documentação oficial em `wakecommerce.readme.io` (as páginas antigas
em `api.fbits.net/Documentacao/*` estão fora do ar, retornando 404).
Tudo abaixo foi verificado na documentação real -- nada aqui foi inventado
ou assumido por analogia. Onde a doc não confirma algo, está marcado
explicitamente como **NÃO CONFIRMADO**.

## Confirmado

- **Base URL**: `https://api.fbits.net`
- **Autenticação**: header `Authorization: BASIC <token>`
- **`GET /pedidos`**: pedidos, paginado (máx. 50/página). `dataFinal` é
  **exclusivo** na prática (a doc diz inclusivo) -- código existente do RD
  Gerencial já compensa com `+timedelta(days=1)`.
- **`PUT /produtos/precos`**: atualização de preço em lote, **máx. 50
  itens por chamada**. Corpo: array de
  `{identificador, precoCusto, precoDe, precoPor, fatorMultiplicadorPreco}`.
  A API rejeita `precoPor` abaixo de `precoCusto` se a config da loja tiver
  essa validação ativa.
- **`PUT /produtos/estoques`**: atualização de estoque em lote, **máx. 50
  itens por chamada**. Corpo: array de
  `{identificador, prazoEntrega, listaEstoque:[{produtoVarianteId, centroDistribuicaoId, estoqueFisico, estoqueReservado, alertaEstoque, permitePreVenda, estoquePreVenda, dataLancamento}]}`.
  **Resposta (confirmada ao vivo 10/09/2026):** ack por variante,
  `{produtosAtualizados:[...], produtosNaoAtualizados:[...]}`, cada entrada
  `{centroDistribuicaoId, produtoVarianteId, sku, resultado, detalhes}`. É
  ESSA a confirmação da escrita -- `engine.ts` confere item a item nela.
- **`produto.dataAtualizacao` NÃO muda com escrita de estoque.** É carimbo
  de catálogo/preço; estoque vive no subsistema de centro de distribuição.
  O código antigo reconferia estoque por esse campo e marcava como falha
  todo item gravado com sucesso (~105 falhas fantasma por run, reenviadas
  pra sempre; todos reportavam o carimbo da sync de PREÇO da véspera).
  Corrigido em 10/09/2026 -- nunca usar `dataAtualizacao` como sinal de
  estoque.
- **`tipoIdentificador` (`/produtos/precos` e `/produtos/estoques`) É QUERY
  PARAM, não campo do corpo.** BUG DE RAIZ encontrado e corrigido em
  09/09/2026: o código antigo mandava `tipoIdentificador: "sku"` dentro de
  cada item do array (ignorado pelo Wake, que não tem esse campo no schema
  do corpo) e nunca mandava o query param -- resultado: o Wake tentava
  interpretar `identificador` como `ProdutoVarianteId` numérico por padrão,
  falhava sempre, e devolvia `produtoVarianteId:0, sku:"-", "Produto \"0\"
  nao encontrado"` pra **100% dos itens em 100% dos lotes**, mesmo com
  `produtoVarianteId` real e confirmado no banco. Ou seja: **nenhuma escrita
  de preço ou estoque nunca chegou a ser aplicada de fato no Wake por essa
  integração antes desse fix**, apesar de logs antigos (antes do fix de
  reconferência) mostrarem "applied" com base só na ausência de erro HTTP.
  Confirmado ao vivo na doc OAS oficial: valores exatos são `"Sku"` ou
  `"ProdutoVarianteId"` (capitalizado, nem `"sku"` nem `"id interno"` como o
  código antigo assumia).
  Referências: https://wakecommerce.readme.io/reference/atualiza-o-preco-de-varios-produtos
  e https://wakecommerce.readme.io/reference/atualiza-o-estoque-de-varios-produtos.
  Fix em `src/lib/wake/client.ts` (`updateWakePrices`/`updateWakeStock` agora
  mandam `params: { tipoIdentificador: 'Sku' }`).
- **`PUT /tabelaPrecos/{tabelaPrecoId}`**: atualiza metadados da tabela de
  preço (`nome, dataInicial, dataFinal, ativo, apenasSite`).
- **`GET /tabelaPrecos/{tabelaPrecoId}/produtos`**: lista os produtos já
  associados a uma tabela de preço (paginado, `pagina`/`quantidadeRegistros`,
  máx. 50/página). **`POST /tabelaPrecos/{tabelaPrecoId}/produtos`**: associa
  uma lista de produto variantes (por `sku`) a uma tabela, cada um com preço
  próprio (`precoDe`, `precoPor`) e vigência opcional (`dataInicio`,
  `dataFim`, não pode passar do fim de vigência da tabela). **`PUT`** no mesmo
  path atualiza os já associados. Isso resolve o item que antes estava
  marcado como não confirmado abaixo -- é o mecanismo real pra "alimentar"
  uma tabela de preço com produtos. Ver
  `src/lib/wake/client.ts:addWakePriceTableProducts` /
  `getWakePriceTableProducts` / `updateWakePriceTableProducts`.
- **`GET /produtos/alteracoes`**: consulta produtos alterados -- usado
  aqui como probe read-only e para reverificar estado real do Wake após
  uma escrita ambígua (timeout, erro de rede no meio da chamada).
- **Rate limit**: **120 requisições/minuto por grupo de endpoint**.
  Resposta de throttle carrega header `Retry-After`. **5 respostas de
  throttle seguidas bloqueiam o token por 1 hora.** Por isso
  `src/lib/wake/client.ts` usa backoff conservador (poucas tentativas,
  circuito aberto ao se aproximar do limiar) em vez de retry agressivo.
- **`GET /lojasFisicas`**: lista lojas físicas/pontos de retirada. Cada item
  traz `lojaId`, `nome`, `ativo` e, crucialmente, **`centroDistribuicaoId`**
  -- esse campo NÃO aparece na tela do admin (`AdicionarLoja?lojaId=N`), só
  o `lojaId` some na URL. É a única forma confirmada de descobrir o
  `WAKE_CD_ID` sem abrir chamado com o suporte Wake.
- **`GET /tabelaPrecos`**: lista todas as tabelas de preço da loja --
  `tabelaPrecoId`, `nome`, `dataInicial/dataFinal`, `ativo`, `isSite`. Usar
  pra descobrir `WAKE_PRICE_TABLE_ID` (ex.: tabela "Tabela de Preço
  Parceiro" vs. a tabela padrão do site).
- **`GET /promocoes?pagina=N`**: confirmado ao vivo em 04/09/2026 (o path
  por convenção estava certo, só a doc pública nunca mostrou o shape).
  Retorna `{ dados: { promocoes: [...], total }, mensagem }`, paginado em
  10 itens/página, sem campo de total de páginas (usar `total` pra saber
  quando parar). Cada item: `promocaoId`, `nome`, `ativo`,
  `dataInicio/dataTermino`, `cupons`. **`GET /promocoes/{id}`** retorna o
  detalhe completo (`{ dados: {...promocao, condicoes, acoes, ...},
  mensagem }`), incluindo `condicoes.argumentos` e `acoes.argumentos` --
  útil pra conferir se a promoção configurada bate com a regra esperada
  (ex.: promoção 10365 "[20%[ a partir de 100 fixadores" tem condição
  quantidade=100 e ação desconto=20.00, confirmado ao vivo). Ver
  `src/lib/wake/client.ts:getWakePromotions` / `getWakePromotionById`.
  Script pronto: `npm run wake:discover-ids` (`scripts/wake-discover-ids.ts`,
  só leitura) -- roda no servidor com `.env` carregado (`set -a; source
  .env; set +a;` antes do `npx tsx`, já que rodar o script direto não
  carrega o `.env` do Next automaticamente), já que o token real só existe
  lá.
- **Modo de controle de estoque**: "Controlar estoque pela FStore" é uma
  config do admin do Wake, ON ou OFF, **sem endpoint de leitura
  documentado**. Precisa ser checado manualmente no admin e gravado em
  `WAKE_STOCK_CONTROL_MODE` (Configurações). ON = o Wake gerencia baixa
  sozinho (o ERP não deve mandar redução); OFF = o ERP precisa mandar a
  baixa explícita quando o pedido muda pra "enviado"/"entregue" -- esta
  primeira versão da integração só EXPÕE estoque (`PUT
  /produtos/estoques` com o valor calculado), não trata baixa por evento
  de pedido; se o modo confirmado for OFF, isso precisa virar um novo
  fluxo antes do go-live.

## Bloqueio ativo no token CISS dedicado (04/09/2026)

Token dedicado instalado em produção, testado ao vivo com resultado misto:

- **`GET /products/prices`, `/products/prices/search`, `/products/prices/{id}`
  -> `401 Unauthorized`.** O token não tem o escopo `product_prices` (só
  `products`, aparentemente). Precisa pedir ao SIGAS pra adicionar esse
  escopo ao mesmo token -- não é bug nosso, a doc já avisava que esses três
  endpoints usam escopo diferente dos demais.
- **`GET /products/stock` -> `500` no lado do SIGAS**, corpo HTML de erro
  do próprio SIGAS: `unsupported format character ',' (0x2c) at index 339`
  (erro de format string em Python, do lado deles). Reproduzido com e sem
  query params -- não é algo que dá pra contornar daqui, precisa reportar
  ao SIGAS como bug no endpoint.

Por causa disso, `CISS_PRICE_PROVIDER` foi mantido/revertido para `mock`
em produção (não dar `live` com token que retorna 401 -- quebraria o sync
noturno de verdade). Só trocar pra `live` depois que o SIGAS confirmar o
escopo `product_prices` liberado E o bug do `/products/stock` corrigido.

## NÃO CONFIRMADO -- não assumir, não inventar

- **Criação de Promoção via API.** Nenhum endpoint de criação de
  promoção foi encontrado na busca pela documentação -- é provável que
  seja só admin-UI. Se for esse o caso, a Promoção "PREÇO CENTO -
  FIXADORES" precisa ser criada manualmente uma vez no admin, e esta
  integração só referencia o `WAKE_PROMOTION_ID` já existente (nunca cria
  uma nova em runtime).
- **Interação preço/cento com PIX/cupom/outras promoções/frete**
  (cumulativo ou não). Precisa ser testado manualmente no ambiente do
  Wake antes do go-live (ver seção de preflight na especificação
  original) -- não há como confirmar isso via documentação de API.

## Cenários de preflight obrigatórios (spec seção 58) -- ainda não executados

1. Compra de 99 unidades vs. 100 unidades de um único SKU whitelisted.
2. Combinação mista de SKUs (alguns atingindo 100un somados, outros não).
3. Mistura de SKU whitelisted com SKU fora da whitelist no mesmo carrinho.

Nenhum desses foi testado ainda -- são bloqueadores pro go-live do preço
de cento, não do scaffolding em si.
