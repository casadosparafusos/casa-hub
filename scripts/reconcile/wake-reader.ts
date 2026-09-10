import { buildUrl, pathOnly, readOnlyGet, sleep, type FetchLike } from './http'

// Leitura da Wake (api.fbits.net) -- somente GET.
//
// O token Wake e COMPARTILHADO com o worker de producao (limite 120 req/min;
// 5 respostas 429 seguidas bloqueiam o token por 1h). Por isso:
//   - teto de 30 req/min (1 request a cada 2s, serializado);
//   - QUALQUER 429 aborta na hora, sem retry;
//   - 401/403 abortam (token errado nao melhora repetindo);
//   - 5xx/rede: no maximo 1 nova tentativa depois de 5s.
// Log so com metadados (path, status, rate-limit restante). Nunca o token.

export const WAKE_BASE_URL = 'https://api.fbits.net'
export const WAKE_PAGE_SIZE = 50
const DEFAULT_MIN_INTERVAL_MS = 2_000
const RETRY_DELAY_MS = 5_000
const LOW_REMAINING_THRESHOLD = 15
const LOW_REMAINING_PAUSE_MS = 60_000
const DEFAULT_TIMEOUT_MS = 30_000

export class WakeAbortError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'WakeAbortError'
  }
}

export class WakeHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'WakeHttpError'
  }
}

export interface WakeReaderOptions {
  token: string
  fetchImpl: FetchLike
  baseUrl?: string
  minIntervalMs?: number
  retryDelayMs?: number
  timeoutMs?: number
  maxPages?: number
  sleepFn?: (ms: number) => Promise<void>
  nowFn?: () => number
  log?: (msg: string) => void
}

export interface WakeProductSnapshot {
  variantId: number | null
  sku: string
  precoDe: number | null
  precoPor: number | null
  /** estoqueFisico da entrada do CD pedido; null = produto sem entrada desse CD. */
  stockCd: number | null
  reservedCd: number | null
  valido: boolean | null
  exibirSite: boolean | null
}

export interface WakePriceTableEntry {
  sku: string
  variantId: number | null
  precoDe: number | null
  precoPor: number | null
  dataInicio: string | null
  dataFim: string | null
}

interface RawStock {
  estoqueFisico?: number | null
  estoqueReservado?: number | null
  centroDistribuicaoId?: number | null
}

interface RawProduct {
  produtoVarianteId?: number | null
  sku?: string | null
  precoDe?: number | null
  precoPor?: number | null
  valido?: boolean | null
  exibirSite?: boolean | null
  estoque?: RawStock[] | null
}

interface RawTableEntry {
  sku?: string | null
  produtoVarianteId?: number | null
  precoDe?: number | null
  precoPor?: number | null
  dataInicio?: string | null
  dataFim?: string | null
}

export interface ProductScan {
  products: WakeProductSnapshot[]
  pages: number
  startCursor: number | null
  lastCursor: number | null
  stopReason: 'empty_page' | 'no_next_page' | 'passed_whitelist_max' | 'max_pages'
  totalCountHeader: number | null
  nonAscendingIds: boolean
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export class WakeReader {
  requestCount = 0
  private lastRequestAt = Number.NEGATIVE_INFINITY
  private pauseBeforeNext = false
  private readonly baseUrl: string
  private readonly minIntervalMs: number
  private readonly retryDelayMs: number
  private readonly timeoutMs: number
  private readonly maxPages: number
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly nowFn: () => number
  private readonly log: (msg: string) => void

  constructor(private readonly opts: WakeReaderOptions) {
    this.baseUrl = opts.baseUrl ?? WAKE_BASE_URL
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxPages = opts.maxPages ?? 2_000
    this.sleepFn = opts.sleepFn ?? sleep
    this.nowFn = opts.nowFn ?? Date.now
    this.log = opts.log ?? (() => {})
  }

  private async throttle(): Promise<void> {
    if (this.pauseBeforeNext) {
      this.pauseBeforeNext = false
      this.log(`[wake] rate-limit restante baixo -- pausa de ${LOW_REMAINING_PAUSE_MS / 1000}s para proteger o worker`)
      await this.sleepFn(LOW_REMAINING_PAUSE_MS)
    }
    const wait = this.lastRequestAt + this.minIntervalMs - this.nowFn()
    if (wait > 0) await this.sleepFn(wait)
    this.lastRequestAt = this.nowFn()
  }

  /** GET com throttle, aborto em 429/401/403 e no maximo 1 retry em 5xx/rede. */
  async get(path: string, params: Record<string, string | number | undefined> = {}): Promise<{ json: unknown; headers: Headers }> {
    const url = buildUrl(this.baseUrl, path, params)
    const headers = { Authorization: `BASIC ${this.opts.token}`, Accept: 'application/json' }
    for (let attempt = 1; attempt <= 2; attempt++) {
      await this.throttle()
      this.requestCount++
      let res
      try {
        res = await readOnlyGet(this.opts.fetchImpl, url, headers, this.timeoutMs)
      } catch (err) {
        const reason = err instanceof Error ? err.name : 'erro'
        this.log(`[wake] GET ${pathOnly(url)} -> falha de rede/timeout (${reason}), tentativa ${attempt}/2`)
        if (attempt === 1) {
          await this.sleepFn(this.retryDelayMs)
          continue
        }
        throw new WakeAbortError(`Wake inacessivel em ${path} apos 2 tentativas (${reason})`)
      }

      const remaining = res.headers.get('x-rate-limit-remaining')
      this.log(`[wake] GET ${pathOnly(url)} -> ${res.status}${remaining !== null ? ` (rate-limit restante=${remaining})` : ''}`)

      if (res.status === 429) {
        throw new WakeAbortError(`Wake respondeu 429 em ${path} -- abortando sem retry (token compartilhado com o worker)`, 429)
      }
      if (res.status === 401 || res.status === 403) {
        throw new WakeAbortError(`Wake respondeu ${res.status} em ${path} -- token sem permissao`, res.status)
      }
      if (res.status >= 500) {
        if (attempt === 1) {
          await this.sleepFn(this.retryDelayMs)
          continue
        }
        throw new WakeAbortError(`Wake respondeu ${res.status} em ${path} apos 2 tentativas`, res.status)
      }
      if (res.status < 200 || res.status >= 300) {
        throw new WakeHttpError(`Wake respondeu ${res.status} em ${path}: ${res.body.slice(0, 200)}`, res.status)
      }

      const remainingNum = remaining !== null ? Number(remaining) : NaN
      if (Number.isFinite(remainingNum) && remainingNum < LOW_REMAINING_THRESHOLD) this.pauseBeforeNext = true

      let json: unknown = null
      if (res.body.trim() !== '') {
        try {
          json = JSON.parse(res.body)
        } catch {
          throw new WakeAbortError(`Wake devolveu corpo nao-JSON em ${path}`)
        }
      }
      return { json, headers: res.headers }
    }
    throw new WakeAbortError(`Wake: tentativas esgotadas em ${path}`)
  }

  /**
   * GET /produtos por cursor (produtoVarianteIdDe, EXCLUSIVO: devolve IDs
   * subsequentes ao informado). NAO usa `pagina` (depreciado pela Wake).
   * `range` limita a varredura ao intervalo de produtoVarianteId da
   * whitelist: comeca em (min - 1) e para quando o cursor passa do max.
   */
  async scanProducts(cdId: number, range?: { minVariantId: number; maxVariantId: number }): Promise<ProductScan> {
    const startCursor = range && range.minVariantId > 1 ? range.minVariantId - 1 : null
    let cursor: number | null = startCursor
    const products: WakeProductSnapshot[] = []
    let pages = 0
    let totalCountHeader: number | null = null
    let nonAscendingIds = false
    let prevId = Number.NEGATIVE_INFINITY

    for (;;) {
      if (pages >= this.maxPages) {
        return { products, pages, startCursor, lastCursor: cursor, stopReason: 'max_pages', totalCountHeader, nonAscendingIds }
      }
      const { json, headers } = await this.get('/produtos', {
        centrosDistribuicao: cdId,
        quantidadeRegistros: WAKE_PAGE_SIZE,
        produtoVarianteIdDe: cursor ?? undefined,
      })
      pages++
      if (!Array.isArray(json)) throw new WakeAbortError('GET /produtos devolveu formato inesperado (esperado array)')
      if (pages === 1) {
        const tc = Number(headers.get('x-total-count'))
        totalCountHeader = Number.isFinite(tc) && headers.get('x-total-count') !== null ? tc : null
      }
      if (json.length === 0) {
        return { products, pages, startCursor, lastCursor: cursor, stopReason: 'empty_page', totalCountHeader, nonAscendingIds }
      }

      let pageMaxId = Number.NEGATIVE_INFINITY
      for (const raw of json as RawProduct[]) {
        const snap = toProductSnapshot(raw, cdId)
        if (snap.variantId !== null) {
          if (snap.variantId < prevId) nonAscendingIds = true
          prevId = snap.variantId
          pageMaxId = Math.max(pageMaxId, snap.variantId)
        }
        products.push(snap)
      }

      const headerCursor = headers.get('x-ultimo-produto-variante-id')
      const next = headerCursor !== null && headerCursor.trim() !== '' ? Number(headerCursor) : pageMaxId
      if (!Number.isFinite(next)) throw new WakeAbortError('GET /produtos sem cursor utilizavel (x-ultimo-produto-variante-id)')
      if (cursor !== null && next <= cursor) throw new WakeAbortError(`cursor da Wake nao avancou (${cursor} -> ${next})`)
      cursor = next

      if (range && next >= range.maxVariantId) {
        return { products, pages, startCursor, lastCursor: cursor, stopReason: 'passed_whitelist_max', totalCountHeader, nonAscendingIds }
      }
      const hasNextHeader = headers.get('x-tem-proxima-pagina')
      const hasNext = hasNextHeader !== null ? hasNextHeader.trim().toLowerCase() === 'true' : json.length >= WAKE_PAGE_SIZE
      if (!hasNext) {
        return { products, pages, startCursor, lastCursor: cursor, stopReason: 'no_next_page', totalCountHeader, nonAscendingIds }
      }
    }
  }

  /** GET /tabelaPrecos/{id}/produtos -- so aceita `pagina` (sem cursor documentado). */
  async readPriceTable(tableId: number): Promise<{ entries: WakePriceTableEntry[]; pages: number }> {
    const entries: WakePriceTableEntry[] = []
    let pages = 0
    for (let pagina = 1; pagina <= this.maxPages; pagina++) {
      const { json } = await this.get(`/tabelaPrecos/${tableId}/produtos`, { pagina, quantidadeRegistros: WAKE_PAGE_SIZE })
      pages++
      if (!Array.isArray(json)) throw new WakeAbortError(`GET /tabelaPrecos/${tableId}/produtos devolveu formato inesperado`)
      for (const raw of json as RawTableEntry[]) {
        if (typeof raw.sku !== 'string') continue
        entries.push({
          sku: raw.sku.trim(),
          variantId: num(raw.produtoVarianteId),
          precoDe: num(raw.precoDe),
          precoPor: num(raw.precoPor),
          dataInicio: raw.dataInicio ?? null,
          dataFim: raw.dataFim ?? null,
        })
      }
      if (json.length < WAKE_PAGE_SIZE) break
    }
    return { entries, pages }
  }

  /** GET /promocoes/{id} -> `dados`. */
  async readPromotion(promotionId: number): Promise<unknown> {
    const { json } = await this.get(`/promocoes/${promotionId}`)
    if (json && typeof json === 'object' && 'dados' in json) return (json as { dados: unknown }).dados
    return json
  }
}

export function toProductSnapshot(raw: RawProduct, cdId: number): WakeProductSnapshot {
  const entry = Array.isArray(raw.estoque) ? raw.estoque.find((e) => e && e.centroDistribuicaoId === cdId) : undefined
  return {
    variantId: num(raw.produtoVarianteId),
    sku: typeof raw.sku === 'string' ? raw.sku.trim() : '',
    precoDe: num(raw.precoDe),
    precoPor: num(raw.precoPor),
    stockCd: entry ? num(entry.estoqueFisico) : null,
    reservedCd: entry ? num(entry.estoqueReservado) : null,
    valido: typeof raw.valido === 'boolean' ? raw.valido : null,
    exibirSite: typeof raw.exibirSite === 'boolean' ? raw.exibirSite : null,
  }
}

// ---------------------------------------------------------------------------
// Promocao -- interpretacao conservadora. A doc da Wake identifica a
// condicao de quantidade minima pelo promocaoCondicaoId 22; o percentual vem
// como argumento numerico das acoes. Se algo nao for determinavel, o status
// e UNVERIFIED (nunca PASS por suposicao) e o JSON cru vai no relatorio pra
// conferencia humana. Nada aqui "corrige" a politica comercial.
// ---------------------------------------------------------------------------

export const QUANTITY_CONDITION_ID = 22

interface PromoArg {
  nrOrdem?: number
  valor?: unknown
}

interface PromoItem {
  promocaoCondicaoId?: number
  promocaoAcaoId?: number
  argumentos?: PromoArg[]
}

export interface PromotionCheck {
  promotion_id: number
  status: 'PASS' | 'FAIL' | 'UNVERIFIED' | 'ERROR'
  nome: string | null
  ativo: boolean | null
  data_inicio: string | null
  data_termino: string | null
  vigente: boolean | null
  quantity_condition_value: number | null
  action_numeric_values: number[]
  expected: { min_qty: number; percent: number }
  checks: { ativo: boolean | null; vigente: boolean | null; quantidade: boolean | null; percentual: boolean | null }
  notes: string[]
  error: string | null
  raw: unknown
}

function numericArg(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  return null
}

export function analyzePromotion(
  promotionId: number,
  dados: unknown,
  now: Date,
  expected: { min_qty: number; percent: number },
): PromotionCheck {
  const notes: string[] = []
  const d = (dados && typeof dados === 'object' ? dados : {}) as {
    estrutura?: { nome?: string; ativo?: boolean; dataInicio?: string | null; dataTermino?: string | null }
    condicoes?: PromoItem[]
    acoes?: PromoItem[]
  }
  const est = d.estrutura ?? {}
  const condicoes = Array.isArray(d.condicoes) ? d.condicoes : []
  const acoes = Array.isArray(d.acoes) ? d.acoes : []

  const ativo = typeof est.ativo === 'boolean' ? est.ativo : null
  const inicio = est.dataInicio ? Date.parse(est.dataInicio) : NaN
  const termino = est.dataTermino ? Date.parse(est.dataTermino) : NaN
  let vigente: boolean | null = null
  if (Number.isFinite(inicio)) {
    vigente = inicio <= now.getTime() && (!Number.isFinite(termino) || now.getTime() <= termino)
  } else {
    notes.push('dataInicio ausente/ilegivel -- vigencia nao determinada')
  }

  const qtyCond = condicoes.find((c) => c.promocaoCondicaoId === QUANTITY_CONDITION_ID)
  let quantity: number | null = null
  if (qtyCond) {
    for (const a of qtyCond.argumentos ?? []) {
      const n = numericArg(a.valor)
      if (n !== null) {
        quantity = n
        break
      }
    }
  } else {
    notes.push(`condicao ${QUANTITY_CONDITION_ID} (quantidade) nao encontrada -- conferir raw.condicoes`)
  }

  const actionValues: number[] = []
  for (const a of acoes) for (const arg of a.argumentos ?? []) {
    const n = numericArg(arg.valor)
    if (n !== null) actionValues.push(n)
  }
  if (acoes.length === 0) notes.push('promocao sem acoes -- percentual nao determinado')
  notes.push('escopo (produtos/categorias) vem nos argumentos das acoes/condicoes -- conferir raw')

  const checks = {
    ativo: ativo === null ? null : ativo === true,
    vigente,
    quantidade: quantity === null ? null : quantity === expected.min_qty,
    percentual: actionValues.length === 0 ? null : actionValues.includes(expected.percent),
  }
  const values = Object.values(checks)
  const status: PromotionCheck['status'] = values.some((v) => v === false) ? 'FAIL' : values.some((v) => v === null) ? 'UNVERIFIED' : 'PASS'

  return {
    promotion_id: promotionId,
    status,
    nome: est.nome ?? null,
    ativo,
    data_inicio: est.dataInicio ?? null,
    data_termino: est.dataTermino ?? null,
    vigente,
    quantity_condition_value: quantity,
    action_numeric_values: actionValues,
    expected,
    checks,
    notes,
    error: null,
    raw: dados,
  }
}
