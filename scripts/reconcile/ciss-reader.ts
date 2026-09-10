import { buildUrl, pathOnly, readOnlyGet, sleep, type FetchLike } from './http'

// Leitura do CISS -- somente GET. Funcao propria (nao reaproveita
// src/lib/ciss/stock.ts) porque o adapter de producao DESCARTA o campo
// `unit`, que aqui e a fonte de verdade da regra de negocio.
//
// Preco: mesma fonte LIVE de producao -- GET /products/prices/search em
// lotes de 150 product_ids, per_page 500, sem overrides.
// Estoque: GET /products/stock?product_id=X, preservando product_id, unit,
// quantity, enterprise e location.

export const CISS_DEFAULT_BASE_URL = 'http://sigas.casadosparafusos.com:5099/api/ciss'
const PRICE_CHUNK_SIZE = 150
const PRICE_PAGE_SIZE = 500
const DEFAULT_TIMEOUT_MS = 20_000
const RETRY_DELAY_MS = 2_000

export class CissAbortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CissAbortError'
  }
}

export class CissRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CissRequestError'
  }
}

export interface CissReaderOptions {
  token: string
  fetchImpl: FetchLike
  baseUrl?: string
  timeoutMs?: number
  concurrency?: number
  maxAttempts?: number
  retryDelayMs?: number
  sleepFn?: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

export interface CissStockRecord {
  productId: string
  /** false = CISS respondeu 200 com data:[] (sem linha em ESTOQUE_SALDO_ATUAL). */
  found: boolean
  unitRaw: string | null
  description: string | null
  reference: string | null
  enterprise: number
  location: number
  /** Quantidade na empresa/local configurados; 0 quando ausente (zero legitimo). */
  quantity: number
  locationPresent: boolean
  companies: Array<{ enterprise_id: number; stocks: Array<{ location_id: number; quantity: number | null }> }>
}

export type CissStockOutcome = { ok: true; record: CissStockRecord } | { ok: false; error: string }

interface StockApiItem {
  product_id?: number | string
  description?: string | null
  unit?: string | null
  reference?: string | null
  companies?: Array<{ enterprise_id?: number; stocks?: Array<{ location_id?: number; quantity?: number | null }> }>
}

interface PriceApiItem {
  product_id?: number | string
  retail_price?: number | null
}

export class CissReader {
  requestCount = 0
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly concurrency: number
  private readonly maxAttempts: number
  private readonly retryDelayMs: number
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly log: (msg: string) => void

  constructor(private readonly opts: CissReaderOptions) {
    this.baseUrl = opts.baseUrl ?? CISS_DEFAULT_BASE_URL
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.concurrency = opts.concurrency ?? 3
    this.maxAttempts = opts.maxAttempts ?? 2
    this.retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS
    this.sleepFn = opts.sleepFn ?? sleep
    this.log = opts.log ?? (() => {})
  }

  async get(path: string, params: Record<string, string | number | undefined>): Promise<unknown> {
    const url = buildUrl(this.baseUrl, path, params)
    const headers = { Authorization: `Bearer ${this.opts.token}`, Accept: 'application/json' }
    let lastError = ''
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this.requestCount++
      let res
      try {
        res = await readOnlyGet(this.opts.fetchImpl, url, headers, this.timeoutMs)
      } catch (err) {
        lastError = `falha de rede/timeout (${err instanceof Error ? err.name : 'erro'})`
        if (attempt < this.maxAttempts) await this.sleepFn(this.retryDelayMs)
        continue
      }
      if (res.status === 401 || res.status === 403) {
        throw new CissAbortError(`CISS respondeu ${res.status} em ${path} -- token sem permissao`)
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = `CISS ${res.status}`
        this.log(`[ciss] GET ${pathOnly(url)} -> ${res.status}, tentativa ${attempt}/${this.maxAttempts}`)
        if (attempt < this.maxAttempts) await this.sleepFn(this.retryDelayMs)
        continue
      }
      if (res.status < 200 || res.status >= 300) {
        throw new CissRequestError(`CISS ${res.status} em ${path}: ${res.body.slice(0, 200)}`)
      }
      try {
        return JSON.parse(res.body)
      } catch {
        throw new CissRequestError(`CISS devolveu corpo nao-JSON em ${path}`)
      }
    }
    throw new CissRequestError(`${lastError || 'falha'} em ${path} apos ${this.maxAttempts} tentativas`)
  }

  /**
   * product_id -> retail_price. Ausente no Map = CISS nao devolveu o produto.
   * Presente com null = CISS devolveu o produto sem preco (o provider live de
   * producao ignora esses -- aqui viram CISS_MISSING com o motivo).
   */
  async readPrices(productIds: string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>()
    for (let i = 0; i < productIds.length; i += PRICE_CHUNK_SIZE) {
      const chunk = productIds.slice(i, i + PRICE_CHUNK_SIZE)
      let page = 1
      for (;;) {
        const res = (await this.get('/products/prices/search', {
          product_ids: chunk.join(','),
          page,
          per_page: PRICE_PAGE_SIZE,
        })) as { data?: PriceApiItem[]; pagination?: { total_pages?: number } } | null
        if (!res || !Array.isArray(res.data)) throw new CissRequestError('CISS /products/prices/search sem data valido')
        for (const item of res.data) {
          if (item.product_id == null) continue
          const price = typeof item.retail_price === 'number' && Number.isFinite(item.retail_price) ? item.retail_price : null
          out.set(String(item.product_id), price)
        }
        const totalPages = res.pagination?.total_pages ?? 1
        if (page >= totalPages) break
        page++
      }
      this.log(`[ciss] precos: ${Math.min(i + PRICE_CHUNK_SIZE, productIds.length)}/${productIds.length}`)
    }
    return out
  }

  async readStock(productId: string, source: { enterprise: number; location: number }): Promise<CissStockRecord> {
    const res = (await this.get('/products/stock', { product_id: productId })) as { data?: StockApiItem[] } | null
    // Resposta sem `data` em array = formato inesperado, NUNCA "estoque zero".
    if (!res || !Array.isArray(res.data)) throw new CissRequestError(`CISS /products/stock sem 'data' valido para product_id=${productId}`)
    const item = res.data.find((r) => String(r.product_id) === productId)
    if (!item) {
      return {
        productId,
        found: false,
        unitRaw: null,
        description: null,
        reference: null,
        enterprise: source.enterprise,
        location: source.location,
        quantity: 0,
        locationPresent: false,
        companies: [],
      }
    }
    const companies = (item.companies ?? []).map((c) => ({
      enterprise_id: Number(c.enterprise_id),
      stocks: (c.stocks ?? []).map((s) => ({
        location_id: Number(s.location_id),
        quantity: typeof s.quantity === 'number' && Number.isFinite(s.quantity) ? s.quantity : null,
      })),
    }))
    const loc = companies.find((c) => c.enterprise_id === source.enterprise)?.stocks.find((s) => s.location_id === source.location)
    return {
      productId,
      found: true,
      unitRaw: typeof item.unit === 'string' ? item.unit : null,
      description: item.description ?? null,
      reference: item.reference ?? null,
      enterprise: source.enterprise,
      location: source.location,
      // Empresa/local ausente = zero legitimo (mesma regra de producao).
      quantity: loc?.quantity ?? 0,
      locationPresent: loc !== undefined,
      companies,
    }
  }

  /** Concorrencia limitada. CissAbortError (401/403) derruba tudo; outros erros ficam por produto. */
  async readStockMany(productIds: string[], source: { enterprise: number; location: number }): Promise<Map<string, CissStockOutcome>> {
    const out = new Map<string, CissStockOutcome>()
    const queue = [...productIds]
    let done = 0
    const state: { aborted: CissAbortError | null } = { aborted: null }
    const worker = async () => {
      while (queue.length > 0 && !state.aborted) {
        const id = queue.shift()
        if (id === undefined) return
        try {
          out.set(id, { ok: true, record: await this.readStock(id, source) })
        } catch (err) {
          if (err instanceof CissAbortError) {
            state.aborted = err
            return
          }
          out.set(id, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
        done++
        if (done % 200 === 0) this.log(`[ciss] estoque: ${done}/${productIds.length}`)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.concurrency, productIds.length)) }, () => worker()))
    if (state.aborted) throw state.aborted
    return out
  }
}
