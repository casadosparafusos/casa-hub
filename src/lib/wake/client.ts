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
 * produtosNaoAtualizados). Esse ack e a fonte de verdade da reconferencia de
 * estoque em src/lib/sync/engine.ts -- NAO da pra reconferir estoque por
 * releitura, porque GET /produtos/{sku} nunca devolve `estoque` preenchido e
 * `dataAtualizacao` so anda em escrita de catalogo/preco, nunca em escrita de
 * estoque (ver o comentario longo em syncStock()).
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
