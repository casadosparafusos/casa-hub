import { CissReader, CissRequestError } from './ciss-reader'
import { buildUrl, readOnlyGet, sleep, type FetchLike } from './http'

// Censo READ-ONLY das unidades de medida (campo `unit`) do CISS.
//
// Fonte: GET /products/stock em modo LISTAGEM (sem product_id), paginado.
// Por produto guarda SO product_id, reference, description e unit_raw --
// `companies`/`quantity` (estoque) sao descartados na leitura, e preco nem
// e consultado. Nenhuma unidade e inferida por nome: o que nao estiver no
// dicionario vira UNSUPPORTED / FUTURE_RULE.

export const STOCK_PATH = '/products/stock'
export const MAX_PER_PAGE = 500
const MAX_EXAMPLES = 5

export interface ProbePagination {
  page: number | null
  per_page: number | null
  total: number | null
  total_pages: number | null
}

export interface ProbeResult {
  /** LISTING_SUPPORTED = 200 + data[] + paginacao numerica. */
  verdict: 'LISTING_SUPPORTED' | 'LISTING_NOT_SUPPORTED' | 'UNEXPECTED_RESPONSE'
  http_status: number | null
  top_level_keys: string[]
  data_is_array: boolean
  data_length: number | null
  pagination: ProbePagination | null
  /** Uniao das chaves dos itens (so nomes, nunca valores). */
  item_keys: string[]
  items_with_unit_field: number
  /** Mensagem do erro (corpo de 4xx truncado ou falha de rede). */
  error: string | null
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function readPagination(raw: unknown): ProbePagination | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  return { page: numOrNull(p.page), per_page: numOrNull(p.per_page), total: numOrNull(p.total), total_pages: numOrNull(p.total_pages) }
}

/** Exatamente UM GET, sem retry: GET /products/stock?page=1&per_page=<n>. */
export async function probeStockListing(opts: {
  token: string
  fetchImpl: FetchLike
  baseUrl: string
  perPage: number
  timeoutMs: number
}): Promise<ProbeResult> {
  const url = buildUrl(opts.baseUrl, STOCK_PATH, { page: 1, per_page: opts.perPage })
  const empty: ProbeResult = {
    verdict: 'UNEXPECTED_RESPONSE',
    http_status: null,
    top_level_keys: [],
    data_is_array: false,
    data_length: null,
    pagination: null,
    item_keys: [],
    items_with_unit_field: 0,
    error: null,
  }
  let res
  try {
    res = await readOnlyGet(opts.fetchImpl, url, { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' }, opts.timeoutMs)
  } catch (err) {
    return { ...empty, error: `falha de rede/timeout (${err instanceof Error ? err.name : 'erro'})` }
  }
  const out: ProbeResult = { ...empty, http_status: res.status }
  let body: unknown = null
  try {
    body = JSON.parse(res.body)
  } catch {
    body = null
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) out.top_level_keys = Object.keys(body).sort()
  if (res.status < 200 || res.status >= 300) {
    out.verdict = res.status === 400 ? 'LISTING_NOT_SUPPORTED' : 'UNEXPECTED_RESPONSE'
    out.error = res.body.slice(0, 300)
    return out
  }
  const obj = (body ?? {}) as { data?: unknown; pagination?: unknown }
  out.data_is_array = Array.isArray(obj.data)
  out.pagination = readPagination(obj.pagination)
  if (Array.isArray(obj.data)) {
    out.data_length = obj.data.length
    const keys = new Set<string>()
    for (const item of obj.data) {
      if (!item || typeof item !== 'object') continue
      for (const k of Object.keys(item)) keys.add(k)
      if ('unit' in item) out.items_with_unit_field++
    }
    out.item_keys = [...keys].sort()
  }
  const p = out.pagination
  if (out.data_is_array && p && p.total_pages !== null && p.total !== null) out.verdict = 'LISTING_SUPPORTED'
  return out
}

export interface CatalogProduct {
  product_id: string
  reference: string | null
  description: string | null
  unit_raw: string | null
}

export interface CatalogReadResult {
  products: CatalogProduct[]
  pages_read: number
  requests: number
  reported_total: number | null
  reported_total_pages: number | null
  duplicates: number
  warnings: string[]
}

interface ListingItem {
  product_id?: number | string
  reference?: unknown
  description?: unknown
  unit?: unknown
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * Percorre a listagem inteira, uma pagina por vez (sequencial), com pausa
 * entre paginas. 401/403 abortam (CissAbortError do reader); 429/5xx tem o
 * retry limitado do reader. Aborta se a paginacao for ignorada pelo servidor
 * (pagina > 1 so com ids ja vistos) ou passar de maxPages.
 */
export async function readCatalogUnits(
  reader: CissReader,
  opts: { perPage: number; pageDelayMs: number; maxPages: number; sleepFn?: (ms: number) => Promise<void>; log?: (msg: string) => void },
): Promise<CatalogReadResult> {
  const sleepFn = opts.sleepFn ?? sleep
  const log = opts.log ?? (() => {})
  const seen = new Map<string, CatalogProduct>()
  const warnings: string[] = []
  const startRequests = reader.requestCount
  let duplicates = 0
  let reportedTotal: number | null = null
  let reportedPages: number | null = null
  let page = 1
  for (;;) {
    if (page > opts.maxPages) throw new CissRequestError(`limite de ${opts.maxPages} paginas atingido -- abortado`)
    const res = (await reader.get(STOCK_PATH, { page, per_page: opts.perPage })) as { data?: ListingItem[]; pagination?: unknown } | null
    if (!res || !Array.isArray(res.data)) throw new CissRequestError(`listagem sem 'data' valido na pagina ${page}`)
    const p = readPagination(res.pagination)
    if (!p || p.total_pages === null) throw new CissRequestError(`listagem sem pagination.total_pages na pagina ${page}`)
    if (page === 1) {
      reportedTotal = p.total
      reportedPages = p.total_pages
    } else if (p.total !== reportedTotal || p.total_pages !== reportedPages) {
      warnings.push(`pagina ${page}: pagination mudou (total ${String(reportedTotal)} -> ${String(p.total)}, total_pages ${String(reportedPages)} -> ${String(p.total_pages)})`)
    }
    if (res.data.length > opts.perPage) warnings.push(`pagina ${page}: ${res.data.length} itens > per_page ${opts.perPage}`)
    let fresh = 0
    for (const item of res.data) {
      if (item.product_id == null) {
        warnings.push(`pagina ${page}: item sem product_id ignorado`)
        continue
      }
      const id = String(item.product_id).trim()
      const unit = strOrNull(item.unit)
      const prev = seen.get(id)
      if (prev) {
        duplicates++
        if (prev.unit_raw !== unit) warnings.push(`product_id ${id} repetido com unit diferente (${JSON.stringify(prev.unit_raw)} x ${JSON.stringify(unit)})`)
        continue
      }
      fresh++
      // So os 4 campos -- companies/quantity (estoque) sao descartados aqui.
      seen.set(id, { product_id: id, reference: strOrNull(item.reference), description: strOrNull(item.description), unit_raw: unit })
    }
    if (page > 1 && res.data.length > 0 && fresh === 0) {
      throw new CissRequestError(`pagina ${page} so trouxe product_ids ja vistos -- paginacao ignorada pelo servidor, abortado`)
    }
    if (page % 10 === 0 || page === p.total_pages) log(`[census] pagina ${page}/${p.total_pages}: ${seen.size} produtos distintos`)
    if (res.data.length === 0 || page >= p.total_pages) break
    page++
    await sleepFn(opts.pageDelayMs)
  }
  if (reportedTotal !== null && reportedTotal !== seen.size + duplicates) {
    warnings.push(`pagination.total=${reportedTotal}, lidos ${seen.size} distintos + ${duplicates} repetidos`)
  }
  return {
    products: [...seen.values()],
    pages_read: page,
    requests: reader.requestCount - startRequests,
    reported_total: reportedTotal,
    reported_total_pages: reportedPages,
    duplicates,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Dicionario candidato. NAO e usado pelo motor de producao: so rotula o censo.

export type UnitStatus = 'OWNER_PROPOSED' | 'CANDIDATE / OWNER_CONFIRMATION_REQUIRED' | 'UNSUPPORTED / FUTURE_RULE'

export interface UnitMapping {
  canonical: string
  strategy: string
  status: UnitStatus
}

export const UNIT_DICTIONARY: Readonly<Record<string, UnitMapping>> = {
  CT: { canonical: 'CENTO', strategy: 'HundredStrategy', status: 'CANDIDATE / OWNER_CONFIRMATION_REQUIRED' },
  PC: { canonical: 'PIECE', strategy: 'PieceStrategy', status: 'OWNER_PROPOSED' },
  UN: { canonical: 'PIECE', strategy: 'PieceStrategy', status: 'OWNER_PROPOSED' },
  KG: { canonical: 'KG_PACKAGE', strategy: 'KgPackageStrategy', status: 'OWNER_PROPOSED' },
}

export const UNSUPPORTED_MAPPING: UnitMapping = { canonical: 'UNSUPPORTED', strategy: 'FUTURE_RULE', status: 'UNSUPPORTED / FUTURE_RULE' }

/** trim + uppercase. null/nao-string -> '(AUSENTE)'; vazio -> '(VAZIO)'. */
export function normalizeUnit(raw: string | null): string {
  if (raw === null) return '(AUSENTE)'
  const n = raw.trim().toUpperCase()
  return n === '' ? '(VAZIO)' : n
}

/** Nunca cai em PC nem CENTO por padrao: desconhecida = UNSUPPORTED. */
export function mapUnit(normalized: string): UnitMapping {
  return Object.prototype.hasOwnProperty.call(UNIT_DICTIONARY, normalized) ? (UNIT_DICTIONARY[normalized] as UnitMapping) : UNSUPPORTED_MAPPING
}

export interface RawUnitAggregate {
  unit_raw: string | null
  unit_normalized: string
  count_catalog: number
  count_current_whitelist: number
  example_product_ids: string[]
  example_references: string[]
}

export interface NormalizedUnitAggregate extends UnitMapping {
  unit_normalized: string
  raw_variants: Array<string | null>
  count_catalog: number
  count_current_whitelist: number
  example_product_ids: string[]
  example_references: string[]
}

export type WhitelistCategory = 'CT' | 'PC' | 'UN' | 'KG' | 'OUTRAS' | 'SEM_REGISTRO'

export interface WhitelistCross {
  total: number
  by_category: Record<WhitelistCategory, number>
  outras_detail: Record<string, number>
  sem_registro_product_ids: string[]
}

function pushExample(list: string[], value: string | null): void {
  if (value && list.length < MAX_EXAMPLES && !list.includes(value)) list.push(value)
}

export function aggregateUnits(
  products: CatalogProduct[],
  whitelistIds: Iterable<string>,
): { raw: RawUnitAggregate[]; normalized: NormalizedUnitAggregate[]; whitelist: WhitelistCross } {
  const wl = new Set([...whitelistIds].map((s) => String(s).trim()))
  const rawMap = new Map<string, RawUnitAggregate>()
  const normMap = new Map<string, NormalizedUnitAggregate>()
  const byId = new Map<string, CatalogProduct>()
  for (const p of products) {
    byId.set(p.product_id, p)
    const inWl = wl.has(p.product_id)
    const rawKey = JSON.stringify(p.unit_raw)
    const norm = normalizeUnit(p.unit_raw)
    let r = rawMap.get(rawKey)
    if (!r) {
      r = { unit_raw: p.unit_raw, unit_normalized: norm, count_catalog: 0, count_current_whitelist: 0, example_product_ids: [], example_references: [] }
      rawMap.set(rawKey, r)
    }
    let n = normMap.get(norm)
    if (!n) {
      n = { unit_normalized: norm, ...mapUnit(norm), raw_variants: [], count_catalog: 0, count_current_whitelist: 0, example_product_ids: [], example_references: [] }
      normMap.set(norm, n)
    }
    if (!n.raw_variants.includes(p.unit_raw)) n.raw_variants.push(p.unit_raw)
    for (const a of [r, n]) {
      a.count_catalog++
      if (inWl) a.count_current_whitelist++
      pushExample(a.example_product_ids, p.product_id)
      pushExample(a.example_references, p.reference?.trim() || null)
    }
  }
  const byCategory: Record<WhitelistCategory, number> = { CT: 0, PC: 0, UN: 0, KG: 0, OUTRAS: 0, SEM_REGISTRO: 0 }
  const outras: Record<string, number> = {}
  const semRegistro: string[] = []
  for (const id of wl) {
    const p = byId.get(id)
    if (!p) {
      byCategory.SEM_REGISTRO++
      semRegistro.push(id)
      continue
    }
    const norm = normalizeUnit(p.unit_raw)
    if (norm === 'CT' || norm === 'PC' || norm === 'UN' || norm === 'KG') byCategory[norm]++
    else {
      byCategory.OUTRAS++
      outras[norm] = (outras[norm] ?? 0) + 1
    }
  }
  const desc = <T extends { count_catalog: number }>(a: T, b: T) => b.count_catalog - a.count_catalog
  return {
    raw: [...rawMap.values()].sort(desc),
    normalized: [...normMap.values()].sort(desc),
    whitelist: { total: wl.size, by_category: byCategory, outras_detail: outras, sem_registro_product_ids: semRegistro.sort((a, b) => Number(a) - Number(b)) },
  }
}
