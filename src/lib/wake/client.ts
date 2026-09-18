import 'server-only'
import { getSecret } from '@/lib/settings'

// -----------------------------------------------------------------------
// Cliente Wake Commerce (Fbits) Admin API -- so os endpoints confirmados
// via documentacao oficial (wakecommerce.readme.io), nunca inventados.
// Ver docs/WAKE-API-CONTRATOS.md pro que esta confirmado vs. em aberto.
//
// Restricao critica: 120 req/min por grupo de endpoint, e 5 respostas de
// throttle (429) seguidas travam o token por 1 HORA. Por isso o backoff
// aqui e deliberadamente mais conservador que o do cliente CISS -- poucas
// tentativas, espera longa, e paramos de vez (sem mais retry) se
// aproximar do limiar de lockout numa mesma execucao.
// -----------------------------------------------------------------------

export class WakeClientError extends Error {}
export class WakeTransientError extends WakeClientError {} // timeout, 5xx, 429 -- retry cauteloso
export class WakePermanentError extends WakeClientError {} // 400/401/403/422 -- nunca repetir

const WAKE_BASE_URL = 'https://api.fbits.net'
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_RETRIES = 2 // conservador de proposito -- ver aviso acima
const THROTTLE_LOCKOUT_LIMIT = 5

let consecutiveThrottles = 0

interface WakeRequestOptions {
  params?: Record<string, string | number | undefined>
  body?: unknown
  timeoutMs?: number
}

async function wakeRequest<T>(method: 'GET' | 'PUT' | 'POST', path: string, options: WakeRequestOptions = {}): Promise<T> {
  const token = await getSecret('WAKE_ADMIN_API_TOKEN')
  if (!token) {
    throw new WakePermanentError('WAKE_ADMIN_API_TOKEN nao configurado (tela de Configuracoes ou .env)')
  }
  if (consecutiveThrottles >= THROTTLE_LOCKOUT_LIMIT) {
    throw new WakePermanentError(
      `Circuito aberto: ${consecutiveThrottles} throttles consecutivos nesta execucao -- ` +
        `parando pra nao arriscar lockout de 1h do token. Tente novamente na proxima execucao agendada.`,
    )
  }

  const url = new URL(path, WAKE_BASE_URL)
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `BASIC ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (res.status === 429) {
        consecutiveThrottles += 1
        const retryAfterHeader = res.headers.get('Retry-After')
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 5000
        if (attempt >= MAX_RETRIES) {
          throw new WakeTransientError(`Wake 429 (throttle) em ${path} -- limite de tentativas atingido`)
        }
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs))
        continue
      }
      // sucesso ou erro nao-429 zera o contador de throttle consecutivo
      consecutiveThrottles = 0

      if (res.status >= 500) {
        if (attempt >= MAX_RETRIES) throw new WakeTransientError(`Wake ${res.status} em ${path}`)
        await new Promise((resolve) => setTimeout(resolve, 3000 * attempt))
        continue
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new WakePermanentError(`Wake ${res.status} em ${path}: ${detail.slice(0, 500)}`)
      }

      const text = await res.text()
      return (text ? JSON.parse(text) : undefined) as T
    } catch (err) {
      clearTimeout(timeout)
      if (err instanceof WakeClientError) throw err
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (attempt >= MAX_RETRIES) throw new WakeTransientError(`Wake timeout em ${path}`)
        continue
      }
      // FASE D-PRE §6 (achado independente do Tech Lead): antes, uma falha de
      // rede REAL (DNS, conexao recusada, socket caiu no meio -- fetch()
      // rejeita com TypeError nesses casos, nao com AbortError) subia direto
      // pro chamador sem NENHUMA tentativa nova, mesmo sendo exatamente o
      // tipo de falha transiente que o retry de 429/5xx/timeout ja existe pra
      // absorver. Agora TypeError tenta de novo com backoff pequeno,
      // respeitando o mesmo MAX_RETRIES -- WakePermanentError continua
      // nunca sendo retentado (ja sobe direto no `if (err instanceof
      // WakeClientError) throw err` acima, antes de chegar aqui).
      if (err instanceof TypeError) {
        if (attempt >= MAX_RETRIES) throw new WakeTransientError(`Falha de rede em ${path}: ${err.message}`)
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
        continue
      }
      throw err
    }
  }
  throw new WakeTransientError(`Falha desconhecida em ${path}`)
}

// --- Precos ---------------------------------------------------------------

export interface WakePriceUpdateItem {
  identificador: string
  precoDe?: number
  precoPor: number
  precoCusto?: number
}

/**
 * PUT /produtos/precos -- lote de ate 50 itens (limite confirmado na doc).
 * Devolve o corpo cru da resposta do Wake (formato NAO documentado
 * publicamente -- ver docs/WAKE-API-CONTRATOS.md). Achado em 08-09/09/2026:
 * essa chamada nao estourar erro NAO prova que os itens do lote foram
 * aceitos individualmente -- por isso o retorno agora e repassado pro
 * chamador (src/lib/sync/engine.ts) em vez de descartado, pra permitir
 * reconferencia por leitura antes de marcar qualquer item como aplicado.
 *
 * BUG DE RAIZ corrigido em 09/09/2026: `tipoIdentificador` NAO e campo do
 * corpo -- e query param (confirmado ao vivo na doc OAS oficial,
 * https://wakecommerce.readme.io/reference/atualiza-o-preco-de-varios-produtos),
 * com valores EXATOS "Sku" ou "ProdutoVarianteId" (nao "sku"/"id interno").
 * Antes o campo ia dentro de cada item do corpo (ignorado pelo Wake, que
 * nao tem esse campo no schema) e o query param nunca era mandado -- o Wake
 * decidia sozinho como interpretar `identificador`. O caso do estoque (mesmo
 * bug, comprovado ao vivo) mostrou que o efeito real e o Wake tentar parsear
 * `identificador` como ProdutoVarianteId numerico e falhar sempre
 * ("Produto \"0\" nao encontrado" pra todo item, mesmo com dado correto).
 */
export async function updateWakePrices(items: WakePriceUpdateItem[]): Promise<unknown> {
  if (items.length > 50) throw new Error('updateWakePrices: lote maior que 50 -- particione antes de chamar')
  return wakeRequest('PUT', '/produtos/precos', { body: items, params: { tipoIdentificador: 'Sku' } })
}

// --- Estoque ----------------------------------------------------------------

export interface WakeStockUpdateItem {
  identificador: string
  prazoEntrega?: number
  listaEstoque: Array<{
    produtoVarianteId: number
    centroDistribuicaoId: number
    estoqueFisico: number
    estoqueReservado?: number
  }>
}

/** Uma entrada do ack por variante devolvido pelo PUT /produtos/estoques. */
export interface WakeStockUpdateResultEntry {
  centroDistribuicaoId?: number
  produtoVarianteId?: number
  sku?: string
  resultado?: boolean
  detalhes?: string
}

/**
 * Corpo de resposta do PUT /produtos/estoques. Formato NAO documentado
 * publicamente, mas confirmado ao vivo em producao (09-10/09/2026, milhares
 * de itens): o Wake devolve um ack POR VARIANTE, dizendo exatamente quais
 * entraram e quais nao, ex.:
 *   {"produtosNaoAtualizados":[],
 *    "produtosAtualizados":[{"centroDistribuicaoId":25,"produtoVarianteId":281145,
 *      "sku":"2823","resultado":true,
 *      "detalhes":"Produto \"2823\" do centro de distribuicao \"25\" atualizado com sucesso"}]}
 */
export interface WakeStockUpdateResponse {
  produtosAtualizados: WakeStockUpdateResultEntry[]
  produtosNaoAtualizados: WakeStockUpdateResultEntry[]
}

function normalizeStockUpdateResponse(raw: unknown): WakeStockUpdateResponse {
  const empty: WakeStockUpdateResponse = { produtosAtualizados: [], produtosNaoAtualizados: [] }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const obj = raw as Record<string, unknown>
  const asList = (v: unknown): WakeStockUpdateResultEntry[] => (Array.isArray(v) ? (v as WakeStockUpdateResultEntry[]) : [])
  return {
    produtosAtualizados: asList(obj.produtosAtualizados),
    produtosNaoAtualizados: asList(obj.produtosNaoAtualizados),
  }
}

/**
 * PUT /produtos/estoques -- lote de ate 50 itens (limite confirmado na doc).
 * Mesmo bug de raiz do `tipoIdentificador` corrigido aqui tambem -- ver
 * comentario acima de updateWakePrices().
 *
 * Diferente de updateWakePrices(), aqui o corpo de resposta e PARSEADO e
 * devolvido tipado (WakeStockUpdateResponse) em vez de cru: descobrimos em
 * 10/09/2026 que esse endpoint ja da o ack definitivo por variante
 * (`resultado` + `detalhes` dentro de produtosAtualizados /
 * produtosNaoAtualizados).
 *
 * FASE C.2: esse ack sozinho NAO e suficiente pra marcar 'applied' -- e sinal
 * de que o Wake ACEITOU a chamada, nao de que o estado remoto de fato ficou
 * no valor esperado (regra canonica: "writer 2xx/ACK != estado remoto
 * verificado"). syncStock() usa o ack so como triagem (rejeitado no ack ->
 * falha direto, sem gastar uma leitura) e, pro que foi aceito, faz uma
 * releitura REAL via readWakeStockByVariantId() antes de confirmar
 * 'applied'. readWakeStockByVariantId() usa o endpoint dedicado
 * `GET /produtos/{identificador}/estoque` (ver comentario dele mais abaixo),
 * que devolve o estoque por centro de distribuicao de verdade -- diferente
 * de `GET /produtos/{sku}`, que sempre devolve `estoque: []` e por isso nunca
 * serviu pra reconferencia.
 */
export async function updateWakeStock(items: WakeStockUpdateItem[]): Promise<WakeStockUpdateResponse> {
  if (items.length > 50) throw new Error('updateWakeStock: lote maior que 50 -- particione antes de chamar')
  const raw = await wakeRequest<unknown>('PUT', '/produtos/estoques', { body: items, params: { tipoIdentificador: 'Sku' } })
  return normalizeStockUpdateResponse(raw)
}

// --- Tabela de precos ---------------------------------------------------

export interface WakePriceTableUpdate {
  nome?: string
  dataInicial?: string
  dataFinal?: string
  ativo?: boolean
  apenasSite?: boolean
}

/**
 * PUT /tabelaPrecos/{id} -- so metadados da tabela (nome/vigencia/ativo).
 * O mecanismo de preco-por-produto DENTRO da tabela nao esta confirmado
 * na documentacao publica -- ver docs/WAKE-API-CONTRATOS.md. NAO assumir
 * que updateWakePrices() escreve nesta tabela automaticamente.
 */
export async function updateWakePriceTable(tabelaPrecoId: number, data: WakePriceTableUpdate): Promise<void> {
  await wakeRequest('PUT', `/tabelaPrecos/${tabelaPrecoId}`, { body: data })
}

export interface WakePriceTableProductItem {
  sku: string
  precoDe: number
  precoPor: number
  dataInicio?: string
  dataFim?: string
}

export interface WakePriceTableProduct {
  tabelaPrecoProdutoVarianteId: number
  tabelaPrecoId: number
  sku: string
  produtoVarianteId: number
  precoDe: number
  precoPor: number
  dataInicio: string
  dataFim: string
  [key: string]: unknown
}

/**
 * GET /tabelaPrecos/{id}/produtos -- lista os produtos ja associados a uma
 * tabela de preco (paginado, max 50/pagina). Confirmado em
 * https://wakecommerce.readme.io/docs/consultando-os-produtos-de-uma-tabela-de-precos.
 */
export async function getWakePriceTableProducts(
  tabelaPrecoId: number,
  params: { pagina?: number; quantidadeRegistros?: number } = {},
): Promise<WakePriceTableProduct[]> {
  return wakeRequest<WakePriceTableProduct[]>('GET', `/tabelaPrecos/${tabelaPrecoId}/produtos`, { params })
}

/**
 * POST /tabelaPrecos/{id}/produtos -- associa uma lista de produto variantes
 * (por SKU) a uma tabela de preco, com preco proprio (precoDe/precoPor) e
 * vigencia opcional. Confirmado em
 * https://wakecommerce.readme.io/docs/inserindo-uma-lista-de-produto-variantes-em-uma-tabela-de-precos.
 * Isso e o mecanismo que faltava documentar em docs/WAKE-API-CONTRATOS.md --
 * ver secao "Confirmado" la, o item "NAO CONFIRMADO" antigo foi superado.
 */
export async function addWakePriceTableProducts(tabelaPrecoId: number, items: WakePriceTableProductItem[]): Promise<void> {
  await wakeRequest('POST', `/tabelaPrecos/${tabelaPrecoId}/produtos`, { body: items })
}

/** PUT /tabelaPrecos/{id}/produtos -- atualiza preco/vigencia de produtos ja associados a tabela. */
export async function updateWakePriceTableProducts(tabelaPrecoId: number, items: WakePriceTableProductItem[]): Promise<void> {
  await wakeRequest('PUT', `/tabelaPrecos/${tabelaPrecoId}/produtos`, { body: items })
}

// --- Lojas fisicas / centros de distribuicao (leitura) --------------------

export interface WakePhysicalStore {
  lojaId: number
  nome: string
  centroDistribuicaoId: number
  ativo: boolean
  [key: string]: unknown
}

/**
 * GET /lojasFisicas -- o admin do Wake so mostra o `lojaId` na URL da tela
 * "Lojas Físicas" (ex. `?lojaId=4`); o `centroDistribuicaoId` (WAKE_CD_ID)
 * so aparece aqui, no corpo da resposta. Ver
 * https://wakecommerce.readme.io/docs/consultando-todas-as-lojas-fisicas.
 */
export async function getWakePhysicalStores(): Promise<WakePhysicalStore[]> {
  return wakeRequest<WakePhysicalStore[]>('GET', '/lojasFisicas')
}

// --- Tabelas de preco (listagem) -------------------------------------------

export interface WakePriceTable {
  tabelaPrecoId: number
  nome: string
  ativo: boolean
  isSite: boolean
  [key: string]: unknown
}

/** GET /tabelaPrecos -- lista todas as tabelas de preco cadastradas na loja. */
export async function getWakePriceTables(): Promise<WakePriceTable[]> {
  return wakeRequest<WakePriceTable[]>('GET', '/tabelaPrecos')
}

// --- Promocoes (listagem) ---------------------------------------------------

export interface WakePromotion {
  promocaoId: number
  nome: string
  ativo: boolean
  dataInicio?: string
  dataTermino?: string
  cupons?: string[] | null
  [key: string]: unknown
}

interface WakePromotionListResponse {
  dados: { promocoes: WakePromotion[]; total: number }
  mensagem?: string
}

/**
 * GET /promocoes -- confirmado ao vivo em 04/09/2026: retorna
 * `{ dados: { promocoes: [...], total }, mensagem }`, paginado em 10 por
 * pagina via `?pagina=N` (nao documentado publicamente, so via teste real).
 * Percorre todas as paginas ate juntar `total` itens.
 */
export async function getWakePromotions(): Promise<WakePromotion[]> {
  const out: WakePromotion[] = []
  for (let pagina = 1; ; pagina++) {
    const res = await wakeRequest<WakePromotionListResponse>('GET', '/promocoes', { params: { pagina } })
    const page = res.dados?.promocoes ?? []
    out.push(...page)
    if (page.length === 0 || out.length >= (res.dados?.total ?? out.length)) break
  }
  return out
}

/** GET /promocoes/{id} -- detalhe de uma promocao (condicoes/acoes inclusas), confirmado ao vivo em 04/09/2026. */
export async function getWakePromotionById(promocaoId: number): Promise<WakePromotion> {
  const res = await wakeRequest<{ dados: WakePromotion; mensagem?: string }>('GET', `/promocoes/${promocaoId}`)
  return res.dados
}

// --- Leitura (probe seguro / verificacao pos-escrita) ------------------

export interface WakeProductChange {
  produtoVarianteId: number
  sku: string
  [key: string]: unknown
}

/** GET /produtos/alteracoes -- usado como probe read-only e pra reverificar estado apos escrita ambigua. */
export async function getWakeProductChanges(params: {
  dataInicial: string
  dataFinal?: string
  pagina?: number
}): Promise<WakeProductChange[]> {
  return wakeRequest<WakeProductChange[]>('GET', '/produtos/alteracoes', { params })
}

export interface WakeProductLookup {
  produtoVarianteId: number
  produtoId: number
  sku: string
  idPaiExterno?: string | null
  idVinculoExterno?: string | null
  nome?: string
  // precoPor/dataAtualizacao tipados explicitamente pq sao usados pra
  // reconferencia pos-escrita em src/lib/sync/engine.ts (ver comentario la).
  // `estoque` tambem existe na resposta mas confirmado ao vivo em 08/09/2026
  // que vem sempre `[]` nesse endpoint (SKUs 7648 e 1563, estoques
  // diferentes) -- por isso NAO da pra usar pra reconferir estoque.
  precoPor?: number
  dataAtualizacao?: string
  [key: string]: unknown
}

/**
 * GET /produtos/{identificador}?tipoIdentificador=sku -- consulta um produto
 * especifico pelo SKU (ou id interno). Confirmado ao vivo em 08/09/2026:
 * sku "1563" -> produtoVarianteId 280340. Doc:
 * https://wakecommerce.readme.io/docs/consultando-um-produto-especifico.
 * E o caminho usado pelo importador de whitelist (src/lib/csv/import.ts)
 * pra resolver o produtoVarianteId sozinho a partir so do wake_sku digitado
 * pelo usuario -- ele nao precisa mais descobrir/colar o variant_id na mao.
 * Retorna null se o SKU nao existir no Wake (422 "Produto nao encontrado"
 * e resposta de negocio, nao erro de transporte -- nunca deve virar retry).
 */
export async function getWakeProductBySku(sku: string): Promise<WakeProductLookup | null> {
  try {
    return await wakeRequest<WakeProductLookup>('GET', `/produtos/${encodeURIComponent(sku)}`, {
      params: { tipoIdentificador: 'sku' },
    })
  } catch (err) {
    if (err instanceof WakePermanentError && /\b422\b/.test(err.message)) return null
    throw err
  }
}

// --- Estoque (leitura pos-escrita, FASE C.2 §2/§3/§4) -----------------------

/** Uma entrada por centro de distribuicao dentro da resposta do endpoint dedicado de estoque. */
export interface WakeStockByCdEntry {
  centroDistribuicaoId?: number
  nome?: string
  estoqueFisico?: number
  estoqueReservado?: number
  [key: string]: unknown
}

/**
 * Corpo de resposta de GET /produtos/{identificador}/estoque. Schema
 * confirmado ao vivo em 17/09/2026 direto do OAS oficial (nao do texto da
 * doc, que so mostra o preview renderizado) via
 * `GET https://wakecommerce.readme.io/wakecommerce/api-next/v2/branches/1.0-readme/reference/retorna-o-estoque-total-e-o-estoque-por-centro-de-distribuicao?reduce=false`,
 * schema.paths["/produtos/{identificador}/estoque"].get.responses.200.
 * `estoqueFisico`/`estoqueReservado` de topo sao o TOTAL agregado entre
 * todos os CDs -- NUNCA usar pra validar a escrita de um CD especifico (ver
 * §3 do relatorio FASE C.2). O estoque por CD vive em
 * `listProdutoVarianteCentroDistribuicaoEstoque[]`.
 */
interface WakeStockReadResponse {
  estoqueFisico?: number
  estoqueReservado?: number
  listProdutoVarianteCentroDistribuicaoEstoque?: WakeStockByCdEntry[]
  [key: string]: unknown
}

/**
 * GET /produtos/{identificador}/estoque?tipoIdentificador=ProdutoVarianteId --
 * endpoint OFICIAL DEDICADO de consulta pontual de estoque (substitui, na
 * FASE C.2, o uso de `GET /produtos` + cursor `produtoVarianteIdDe` da FASE
 * C.1 -- ver docs/WAKE-API-CONTRATOS.md pro historico). Confirmado ao vivo
 * em 17/09/2026 na doc oficial (wakecommerce.readme.io): path, query param
 * `tipoIdentificador` (enum `Sku`|`ProdutoVarianteId`) e o schema de
 * resposta completo (ver WakeStockReadResponse acima). Reaproveita
 * wakeRequest() -- mesmo auth/retry/backoff/timeout/rate-limit/error-handling
 * de todo o cliente Wake, nenhum cliente HTTP paralelo.
 *
 * Selecao do CD: estritamente `centroDistribuicaoId === cdId` dentro de
 * `listProdutoVarianteCentroDistribuicaoEstoque[]`. Se o CD esperado nao
 * aparecer nessa lista, devolve `null` (nao verificavel) -- NUNCA aceita o
 * total agregado do topo como substituto, e nunca considera silenciosamente
 * `0`.
 *
 * Campo comparado: `estoqueFisico` da entrada do CD. Auditado contra o
 * writer (`updateWakeStock()` acima, `WakeStockUpdateItem.listaEstoque[]`):
 * o writer grava exatamente `estoqueFisico` por CD, entao writer e reader
 * comparam o MESMO campo/semantica -- nao ha necessidade de ajuste (ver §4
 * do relatorio). `estoqueReservado` nunca e subtraido nem comparado aqui --
 * documentado a parte (relatorio FASE C.2, secao Semantics).
 *
 * Retorna `null` pra qualquer caso NAO verificavel, nunca aceitando
 * silenciosamente um valor incerto:
 *   - 404 ("Produto Nao Encontrado" -- identificador nao existe na Wake);
 *   - campo `listProdutoVarianteCentroDistribuicaoEstoque` ausente/nao-array;
 *   - nenhuma entrada da lista com `centroDistribuicaoId === cdId`;
 *   - `estoqueFisico` da entrada do CD ausente, nao-numerico ou nao-finito.
 * Erro de rede/protocolo (WakeClientError transiente ou permanente que nao
 * seja 404) propaga pro chamador -- quem chama trata esse throw como
 * FAILED, nunca como MISMATCH (ver syncStock()). 404 nunca e retentado --
 * wakeRequest() so retenta 429/5xx/timeout, um 404 cai direto no ramo
 * `!res.ok` e lanca de primeira (ver comentario de wakeRequest() acima).
 */
export async function readWakeStockByVariantId(variantId: number, cdId: number): Promise<number | null> {
  let response: WakeStockReadResponse
  try {
    response = await wakeRequest<WakeStockReadResponse>('GET', `/produtos/${variantId}/estoque`, {
      params: { tipoIdentificador: 'ProdutoVarianteId' },
    })
  } catch (err) {
    if (err instanceof WakePermanentError && /\b404\b/.test(err.message)) return null
    throw err
  }

  const list = response?.listProdutoVarianteCentroDistribuicaoEstoque
  if (!Array.isArray(list)) return null

  const entry = list.find((e) => e.centroDistribuicaoId === cdId)
  if (!entry || typeof entry.estoqueFisico !== 'number' || !Number.isFinite(entry.estoqueFisico)) return null
  return entry.estoqueFisico
}

/** Uma entrada de `tabelasPreco[]` no corpo de GET /produtos/{identificador}?camposAdicionais=TabelaPreco. */
interface WakeProductTabelaPrecoEntry {
  tabelaPrecoId?: number
  nome?: string
  precoDe?: number
  precoPor?: number
  [key: string]: unknown
}

interface WakeProductWithTabelasPrecoResponse {
  tabelasPreco?: WakeProductTabelaPrecoEntry[]
  [key: string]: unknown
}

/**
 * GET /produtos/{identificador}?tipoIdentificador=ProdutoVarianteId&camposAdicionais=TabelaPreco --
 * leitura pontual direcionada de uma Tabela de Preco especifica pra 1
 * produto, criada na revisao do Tech Lead do PR #4 (fix #4, 2026-09-18)
 * pra substituir a segunda releitura paginada da Tabela 74 inteira em
 * syncPrices() (src/lib/sync/engine.ts). Endpoint e schema confirmados na
 * doc oficial Wake:
 *   - https://wakecommerce.readme.io/reference/retorna-um-produto-buscando-pelo-seu-identificador
 *   - https://wakecommerce.readme.io/docs/consultando-um-produto-especifico
 * `camposAdicionais=TabelaPreco` inclui `tabelasPreco[]` no corpo, cada
 * entrada com `tabelaPrecoId`/`precoDe`/`precoPor`. Reaproveita
 * wakeRequest() -- mesmo auth/retry/backoff/timeout/rate-limit/error-
 * handling de todo o cliente Wake, nenhum cliente HTTP paralelo (mesmo
 * padrao de readWakeStockByVariantId() acima).
 *
 * Selecao da tabela: estritamente `tabelasPreco.find(t => t.tabelaPrecoId
 * === tableId)`. NUNCA usa outra tabela como fallback, mesmo que so exista
 * uma entrada na lista -- um produto pode estar associado a mais de uma
 * Tabela de Preco.
 *
 * Retorna `null` pra qualquer caso NAO verificavel, nunca aceitando
 * silenciosamente um valor incerto:
 *   - 404/422 (produto/variante "nao encontrado" -- mesmo tratamento de
 *     business-not-found que getWakeProductBySku() ja aplica pro mesmo
 *     endpoint, revisao Tech Lead PR #4, final polish, item 2);
 *   - campo `tabelasPreco` ausente/nao-array;
 *   - nenhuma entrada da lista com `tabelaPrecoId === tableId`;
 *   - `precoDe`/`precoPor` da entrada ausente, nao-numerico ou nao-finito.
 * Demais erros permanentes (WakePermanentError fora de 404/422) e erros
 * transientes propagam pro chamador -- quem chama trata esse throw como
 * FAILED, nunca como MISMATCH (mesmo criterio de readWakeStockByVariantId).
 *
 * Chamador responsavel por serializar/pacear as chamadas (ex.:
 * WAKE_VERIFY_DELAY_MS em engine.ts) -- esta funcao nao faz rate limiting
 * proprio, so uma chamada por invocacao.
 */
export async function readWakePriceTableByVariantId(variantId: number, tableId: number): Promise<{ precoDe: number; precoPor: number } | null> {
  let response: WakeProductWithTabelasPrecoResponse
  try {
    response = await wakeRequest<WakeProductWithTabelasPrecoResponse>('GET', `/produtos/${variantId}`, {
      params: { tipoIdentificador: 'ProdutoVarianteId', camposAdicionais: 'TabelaPreco' },
    })
  } catch (err) {
    // 404 e 422 ("produto nao encontrado") sao tratados como o mesmo caso de
    // negocio aqui: mesmo endpoint (/produtos/{id}) que getWakeProductBySku
    // ja trata assim acima -- consistencia de contrato, nao suposicao nova.
    if (err instanceof WakePermanentError && /\b(404|422)\b/.test(err.message)) return null
    throw err
  }

  const list = response?.tabelasPreco
  if (!Array.isArray(list)) return null

  const entry = list.find((t) => t.tabelaPrecoId === tableId)
  if (!entry || typeof entry.precoDe !== 'number' || !Number.isFinite(entry.precoDe) || typeof entry.precoPor !== 'number' || !Number.isFinite(entry.precoPor)) {
    return null
  }
  return { precoDe: entry.precoDe, precoPor: entry.precoPor }
}
