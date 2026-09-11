import { CissAbortError, CissReader, type CissReaderOptions, type CissStockOutcome } from './ciss-reader'
import type { ManagedProductRow } from './db-readonly'
import type { FetchLike } from './http'
import { reconcileAll, type Aggregates, type ReconciliationRow } from './reconcile'
import {
  CENTO_RETAIL_MULTIPLIER,
  CENTO_STOCK_PERCENT,
  CENTO_UNITS,
  PRICE_TOLERANCE,
  WHOLESALE_MIN_QTY,
  WHOLESALE_MULTIPLIER,
} from './rules'
import {
  analyzePromotion,
  PRODUCTS_EXTRA_FIELDS,
  WakeAbortError,
  WakeHttpError,
  WakeReader,
  type ProductScan,
  type PromotionCheck,
  type WakePriceTableEntry,
  type WakeProductSnapshot,
  type WakeReaderOptions,
} from './wake-reader'

// Orquestracao da reconciliacao READ-ONLY. Ordem:
//   1. Wake: /produtos (cursor) -> tabela de preco -> promocao. Qualquer
//      WakeAbortError (429, 401/403, 5xx repetido) PARA de chamar a Wake.
//   2. CISS: precos (lotes) -> estoque por produto (preserva `unit`). Roda
//      mesmo com a Wake abortada -- a distribuicao de UNIT continua util.
//   3. Reconciliacao pura + agregados.

export interface RunConfig {
  products: ManagedProductRow[]
  wakeToken: string | null
  cissToken: string | null
  wakeCdId: number
  priceTableId: number | null
  promotionId: number | null
  cissEnterprise: number
  cissLocation: number
  wakeFetch: FetchLike
  cissFetch: FetchLike
  cissBaseUrl?: string
  wakeOptions?: Partial<Omit<WakeReaderOptions, 'token' | 'fetchImpl'>>
  cissOptions?: Partial<Omit<CissReaderOptions, 'token' | 'fetchImpl'>>
  /** Limita a varredura de /produtos ao intervalo de produtoVarianteId da whitelist. */
  useVariantRange: boolean
  packageWeights?: Map<string, number>
  log?: (msg: string) => void
  now?: () => Date
  extraMeta?: Record<string, unknown>
}

export interface ReconciliationReport {
  meta: Record<string, unknown>
  aggregates: Aggregates
  promotion_check: PromotionCheck | null
  wake_scan: Omit<ProductScan, 'products'> | null
  rows: ReconciliationRow[]
}

export function variantRange(products: ManagedProductRow[]): { minVariantId: number; maxVariantId: number } | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const p of products) {
    const n = Number(p.wakeVariantId)
    if (!Number.isInteger(n) || n <= 0) return null
    min = Math.min(min, n)
    max = Math.max(max, n)
  }
  return Number.isFinite(min) ? { minVariantId: min, maxVariantId: max } : null
}

export async function runReconciliation(cfg: RunConfig): Promise<ReconciliationReport> {
  const log = cfg.log ?? (() => {})
  const now = cfg.now ?? (() => new Date())
  const startedAt = now()
  const warnings: string[] = []

  // ------------------------------------------------------------------ Wake
  let wakeProducts: Map<string, WakeProductSnapshot> | null = null
  let wakeTable: Map<string, WakePriceTableEntry> | null = null
  let wakeError: string | null = null
  let tableError: string | null = null
  let wakeAbortStatus: number | null = null
  let scanMeta: Omit<ProductScan, 'products'> | null = null
  let tablePages = 0
  let promotionCheck: PromotionCheck | null = null
  const promoExpected = { min_qty: WHOLESALE_MIN_QTY, percent: Math.round((1 - WHOLESALE_MULTIPLIER) * 100) }
  let wakeReader: WakeReader | null = null

  if (!cfg.wakeToken) {
    wakeError = 'WAKE_ADMIN_API_TOKEN ausente'
  } else {
    wakeReader = new WakeReader({ token: cfg.wakeToken, fetchImpl: cfg.wakeFetch, log, ...cfg.wakeOptions })
    try {
      const range = cfg.useVariantRange ? variantRange(cfg.products) : null
      if (cfg.useVariantRange && !range) warnings.push('intervalo de produtoVarianteId indisponivel -- varredura completa de /produtos')
      log(`[wake] GET /produtos CD=${cfg.wakeCdId}${range ? ` intervalo ${range.minVariantId}..${range.maxVariantId}` : ' (catalogo inteiro)'}`)
      const scan = await wakeReader.scanProducts(cfg.wakeCdId, range ?? undefined)
      const { products, ...meta } = scan
      scanMeta = meta
      if (scan.nonAscendingIds) warnings.push('Wake devolveu produtoVarianteId fora de ordem crescente -- WAKE_MISSING pode estar superestimado')
      if (!scan.stockVerifiable) {
        warnings.push(`ESTOQUE WAKE NAO VERIFICAVEL: ${scan.stockUnverifiableReason ?? 'motivo desconhecido'} -- linhas viram ERROR, nunca STOCK_MISMATCH`)
      } else if (scan.stockFieldMissing > 0) {
        warnings.push(`${scan.stockFieldMissing} produto(s) de GET /produtos sem o campo estoque[] -- essas linhas viram ERROR (estoque nao verificavel)`)
      }
      if (scan.stopReason === 'max_pages') throw new WakeAbortError('limite de paginas de /produtos atingido')
      wakeProducts = new Map()
      for (const snap of products) {
        if (!snap.sku) continue
        if (wakeProducts.has(snap.sku)) warnings.push(`SKU duplicado na Wake: ${snap.sku}`)
        else wakeProducts.set(snap.sku, snap)
      }

      if (cfg.priceTableId !== null) {
        try {
          const table = await wakeReader.readPriceTable(cfg.priceTableId)
          tablePages = table.pages
          wakeTable = new Map(table.entries.map((e) => [e.sku, e]))
        } catch (err) {
          if (err instanceof WakeHttpError) tableError = err.message
          else throw err
        }
      } else {
        tableError = 'WAKE_PRICE_TABLE_ID nao configurado'
      }

      if (cfg.promotionId !== null) {
        try {
          const dados = await wakeReader.readPromotion(cfg.promotionId)
          const scope = cfg.products.map((p) => {
            const vid = Number(p.wakeVariantId)
            return { sku: p.wakeSku, variantId: Number.isInteger(vid) ? vid : null }
          })
          promotionCheck = analyzePromotion(cfg.promotionId, dados, now(), promoExpected, scope)
        } catch (err) {
          if (err instanceof WakeHttpError) promotionCheck = promotionError(cfg.promotionId, err.message, promoExpected)
          else throw err
        }
      }
    } catch (err) {
      if (!(err instanceof WakeAbortError)) throw err
      wakeError = err.message
      wakeAbortStatus = err.status ?? null
      wakeProducts = null
      log(`[wake] ABORTADO: ${err.message}`)
      if (cfg.promotionId !== null && !promotionCheck) promotionCheck = promotionError(cfg.promotionId, `nao lida: ${err.message}`, promoExpected)
    }
  }

  // ------------------------------------------------------------------ CISS
  let cissPrices: Map<string, number | null> | null = null
  let cissStock: Map<string, CissStockOutcome> | null = null
  let cissError: string | null = null
  let cissReader: CissReader | null = null
  const ids = [...new Set(cfg.products.map((p) => p.cissProductId))]
  if (!cfg.cissToken) {
    cissError = 'CISS_API_TOKEN ausente'
  } else {
    cissReader = new CissReader({
      token: cfg.cissToken,
      fetchImpl: cfg.cissFetch,
      log,
      ...(cfg.cissBaseUrl ? { baseUrl: cfg.cissBaseUrl } : {}),
      ...cfg.cissOptions,
    })
    try {
      log(`[ciss] precos de ${ids.length} produtos`)
      cissPrices = await cissReader.readPrices(ids)
      log(`[ciss] estoque de ${ids.length} produtos (empresa ${cfg.cissEnterprise}, local ${cfg.cissLocation})`)
      cissStock = await cissReader.readStockMany(ids, { enterprise: cfg.cissEnterprise, location: cfg.cissLocation })
    } catch (err) {
      cissError = `leitura CISS falhou: ${err instanceof Error ? err.message : String(err)}`
      if (!(err instanceof CissAbortError)) log(`[ciss] ${cissError}`)
      cissPrices = null
      cissStock = null
    }
  }

  const { rows, aggregates } = reconcileAll({
    products: cfg.products,
    cissPrices,
    cissStock,
    cissError,
    wakeProducts,
    wakeError,
    wakeTable,
    tableError,
    packageWeights: cfg.packageWeights ?? new Map(),
  })

  const finishedAt = now()
  return {
    meta: {
      mode: 'READ_ONLY',
      generated_at: finishedAt.toISOString(),
      started_at: startedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      aborted: wakeError !== null || cissError !== null,
      wake_aborted: wakeError !== null,
      wake_abort_reason: wakeError,
      wake_abort_status: wakeAbortStatus,
      ciss_error: cissError,
      price_table_error: tableError,
      wake_requests: wakeReader?.requestCount ?? 0,
      wake_price_table_pages: tablePages,
      ciss_requests: cissReader?.requestCount ?? 0,
      wake_stock_verifiable: scanMeta?.stockVerifiable ?? null,
      wake_stock_unverifiable_reason: scanMeta?.stockUnverifiableReason ?? null,
      wake_stock_field_present: scanMeta?.stockFieldPresent ?? null,
      wake_stock_field_missing: scanMeta?.stockFieldMissing ?? null,
      config: {
        wake_cd_id: cfg.wakeCdId,
        wake_price_table_id: cfg.priceTableId,
        wake_promotion_id: cfg.promotionId,
        ciss_stock_enterprise: cfg.cissEnterprise,
        ciss_stock_location: cfg.cissLocation,
        variant_range_scan: cfg.useVariantRange,
        wake_products_extra_fields: PRODUCTS_EXTRA_FIELDS,
        ciss_stock_concurrency: cissReader?.concurrencyLimit ?? null,
      },
      rules: {
        cento_units: CENTO_UNITS,
        cento_stock_percent: CENTO_STOCK_PERCENT,
        cento_retail_multiplier: CENTO_RETAIL_MULTIPLIER,
        wholesale_multiplier: WHOLESALE_MULTIPLIER,
        wholesale_min_qty: WHOLESALE_MIN_QTY,
        price_tolerance: PRICE_TOLERANCE,
        price_table_expected: 'precoPor = varejo esperado (precoDe da tabela registrado, sem julgamento)',
        kg_package_weights_configured: cfg.packageWeights?.size ?? 0,
      },
      warnings,
      ...cfg.extraMeta,
    },
    aggregates,
    promotion_check: promotionCheck,
    wake_scan: scanMeta,
    rows,
  }
}

function promotionError(id: number, error: string, expected: { min_qty: number; percent: number }): PromotionCheck {
  return {
    promotion_id: id,
    status: 'ERROR',
    nome: null,
    ativo: null,
    data_inicio: null,
    data_termino: null,
    vigente: null,
    quantity_condition_value: null,
    action_ids: [],
    action_descriptors: [],
    action_numeric_values: [],
    scope: { source: null, listed_count: null, whitelist_count: 0, covered: null, missing_sample: [] },
    expected,
    checks: { ativo: null, vigente: null, quantidade: null, acao: null, escopo: null },
    notes: [],
    error,
    raw: null,
  }
}
