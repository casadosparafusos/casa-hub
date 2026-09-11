import type { CissStockOutcome } from './ciss-reader'
import type { ManagedProductRow } from './db-readonly'
import { classifyUnit, computeExpected, pricesMatch } from './rules'
import type { WakePriceTableEntry, WakeProductSnapshot } from './wake-reader'

// Nucleo puro da reconciliacao: CISS real -> UNIT -> regra esperada -> Wake
// real. Sem I/O. Nao corrige nada, so classifica.

export const STATUSES = [
  'MATCH',
  'PRICE_MISMATCH',
  'STOCK_MISMATCH',
  'PRICE_AND_STOCK_MISMATCH',
  'CISS_MISSING',
  'WAKE_MISSING',
  'UNSUPPORTED_UNIT',
  'CONFIGURATION_REQUIRED',
  'ERROR',
] as const
export type RowStatus = (typeof STATUSES)[number]

export interface ReconciliationRow {
  ciss_product_id: string
  wake_sku: string
  wake_variant_id: string
  unit: string | null
  unit_raw: string | null
  ciss_price: number | null
  ciss_stock: number | null
  ciss_enterprise: number | null
  ciss_location: number | null
  package_weight_kg: number | null
  expected_retail_price: number | null
  expected_wholesale_price: number | null
  wake_current_price: number | null
  price_match: boolean | null
  expected_stock: number | null
  wake_current_stock: number | null
  stock_match: boolean | null
  price_table_expected: number | null
  price_table_actual: number | null
  price_table_match: boolean | null
  wake_variant_id_actual: number | null
  wake_preco_de: number | null
  price_table_preco_de_actual: number | null
  status: RowStatus
  error: string | null
}

export interface ReconcileInput {
  products: ManagedProductRow[]
  /** null = leitura de precos CISS nao aconteceu (ver cissError). */
  cissPrices: Map<string, number | null> | null
  cissStock: Map<string, CissStockOutcome> | null
  cissError: string | null
  /** Por SKU. null = leitura Wake de /produtos incompleta (ver wakeError). */
  wakeProducts: Map<string, WakeProductSnapshot> | null
  wakeError: string | null
  /** Por SKU. null = tabela nao lida (ver tableError). */
  wakeTable: Map<string, WakePriceTableEntry> | null
  tableError: string | null
  /** ciss_product_id -> kg por caixa (so UNIT=KG). Vazio nesta rodada. */
  packageWeights: Map<string, number>
}

export interface Aggregates {
  whitelist_total: number
  ciss_found: number
  ciss_missing: number
  ciss_no_stock_record: number
  wake_found: number
  wake_missing: number
  unit_cento: number
  unit_pc: number
  unit_un: number
  unit_kg: number
  unit_unsupported: number
  unit_missing: number
  unit_raw_distribution: Record<string, number>
  price_matches: number
  price_mismatches: number
  stock_matches: number
  stock_mismatches: number
  /** Linhas em que o estoque Wake nao pode ser lido (campo/CD/valor ausente) -- nunca contadas como mismatch. */
  stock_unverifiable: number
  price_table_matches: number
  price_table_mismatches: number
  configuration_required: number
  errors: number
  status_counts: Record<RowStatus, number>
}

function emptyRow(p: ManagedProductRow): ReconciliationRow {
  return {
    ciss_product_id: p.cissProductId,
    wake_sku: p.wakeSku,
    wake_variant_id: p.wakeVariantId,
    unit: null,
    unit_raw: null,
    ciss_price: null,
    ciss_stock: null,
    ciss_enterprise: null,
    ciss_location: null,
    package_weight_kg: null,
    expected_retail_price: null,
    expected_wholesale_price: null,
    wake_current_price: null,
    price_match: null,
    expected_stock: null,
    wake_current_stock: null,
    stock_match: null,
    price_table_expected: null,
    price_table_actual: null,
    price_table_match: null,
    wake_variant_id_actual: null,
    wake_preco_de: null,
    price_table_preco_de_actual: null,
    status: 'ERROR',
    error: null,
  }
}

function finish(row: ReconciliationRow, status: RowStatus, notes: string[]): ReconciliationRow {
  row.status = status
  row.error = notes.length > 0 ? notes.join('; ') : null
  return row
}

export function reconcileProduct(p: ManagedProductRow, input: ReconcileInput): ReconciliationRow {
  const row = emptyRow(p)
  const notes: string[] = []

  // Wake (preenche o que houver, independente do status final).
  const wp = input.wakeProducts?.get(p.wakeSku)
  if (wp) {
    row.wake_current_price = wp.precoPor
    row.wake_current_stock = wp.stockCd
    row.wake_variant_id_actual = wp.variantId
    row.wake_preco_de = wp.precoDe
    if (wp.variantId !== null && String(wp.variantId) !== p.wakeVariantId) {
      notes.push(`produtoVarianteId na Wake (${wp.variantId}) difere do cadastrado (${p.wakeVariantId})`)
    }
  }
  const te = input.wakeTable?.get(p.wakeSku)
  if (te) {
    row.price_table_actual = te.precoPor
    row.price_table_preco_de_actual = te.precoDe
  }

  // CISS
  if (input.cissError || !input.cissStock || !input.cissPrices) {
    return finish(row, 'ERROR', [input.cissError ?? 'leitura CISS nao executada', ...notes])
  }
  const outcome = input.cissStock.get(p.cissProductId)
  if (!outcome) return finish(row, 'ERROR', ['sem leitura de estoque CISS', ...notes])
  if (!outcome.ok) return finish(row, 'ERROR', [outcome.error, ...notes])
  const rec = outcome.record
  row.unit_raw = rec.unitRaw
  row.ciss_stock = rec.found ? rec.quantity : null
  row.ciss_enterprise = rec.enterprise
  row.ciss_location = rec.location
  const hasPrice = input.cissPrices.has(p.cissProductId)
  const price = input.cissPrices.get(p.cissProductId) ?? null
  row.ciss_price = price

  if (!rec.found) {
    notes.unshift('CISS /products/stock sem registro (data:[]); producao trata como estoque 0')
    if (!hasPrice) notes.push('ausente em /products/prices/search')
    else if (price === null) notes.push('retail_price null no CISS')
    return finish(row, 'CISS_MISSING', notes)
  }
  if (!rec.locationPresent) notes.push(`sem saldo na empresa ${rec.enterprise}/local ${rec.location} (zero legitimo)`)

  const unit = classifyUnit(rec.unitRaw)
  if (unit.kind === 'ok') row.unit = unit.unit

  if (!hasPrice || price === null) {
    notes.unshift(!hasPrice ? 'ausente em /products/prices/search' : 'retail_price null no CISS')
    return finish(row, 'CISS_MISSING', notes)
  }
  if (unit.kind === 'missing') return finish(row, 'UNSUPPORTED_UNIT', ['unit ausente no CISS', ...notes])
  if (unit.kind === 'unsupported') return finish(row, 'UNSUPPORTED_UNIT', [`unit nao suportada: "${unit.raw}"`, ...notes])

  const weight = unit.unit === 'KG' ? (input.packageWeights.get(p.cissProductId) ?? null) : null
  row.package_weight_kg = weight
  const expected = computeExpected({ unit: unit.unit, cissPrice: price, cissStock: rec.quantity, packageWeightKg: weight })
  if (expected.kind === 'configuration_required') return finish(row, 'CONFIGURATION_REQUIRED', [expected.error, ...notes])
  if (expected.kind === 'invalid_input') return finish(row, 'ERROR', [expected.error, ...notes])

  row.expected_retail_price = expected.expectedRetailPrice
  row.expected_wholesale_price = expected.expectedWholesalePrice
  row.expected_stock = expected.expectedStock
  row.price_table_expected = expected.priceTableExpected
  if (expected.floatEdgeNote) notes.push(expected.floatEdgeNote)

  // Comparacao contra a Wake
  if (input.wakeError || !input.wakeProducts) {
    return finish(row, 'ERROR', [`leitura Wake incompleta: ${input.wakeError ?? 'nao executada'}`, ...notes])
  }
  if (!wp) return finish(row, 'WAKE_MISSING', ['SKU nao encontrado em GET /produtos (CD configurado)', ...notes])

  row.price_match = pricesMatch(expected.expectedRetailPrice, wp.precoPor) === true
  if (wp.precoPor === null) notes.push('Wake sem precoPor')

  if (input.tableError || !input.wakeTable) {
    row.price_table_match = null
    notes.push(`tabela de preco nao lida: ${input.tableError ?? 'nao executada'}`)
  } else {
    row.price_table_match = te ? pricesMatch(expected.priceTableExpected, te.precoPor) === true : false
    if (!te) notes.push('SKU ausente na tabela de preco')
  }

  // Fail-safe: estoque Wake so e comparado quando foi lido de fato. Campo
  // ausente / sem entrada do CD / valor invalido NAO vira STOCK_MISMATCH --
  // vira ERROR explicito (price_match continua preenchido para auditoria).
  if (wp.stockStatus !== 'ok' || wp.stockCd === null) {
    row.stock_match = null
    const why =
      wp.stockStatus === 'no_field'
        ? 'resposta de GET /produtos sem o campo estoque[]'
        : wp.stockStatus === 'no_cd_entry'
          ? 'estoque[] sem entrada do CD configurado'
          : 'estoqueFisico do CD nao numerico'
    const pricePart = `preco ${row.price_match ? 'confere' : 'DIVERGE'}${row.price_table_match === false ? ' (tabela DIVERGE)' : ''}`
    return finish(row, 'ERROR', [`estoque Wake nao verificavel (${wp.stockStatus}): ${why}; ${pricePart}`, ...notes])
  }
  row.stock_match = wp.stockCd === expected.expectedStock

  const priceOk = row.price_match && row.price_table_match !== false
  const stockOk = row.stock_match
  const status: RowStatus = priceOk && stockOk ? 'MATCH' : !priceOk && !stockOk ? 'PRICE_AND_STOCK_MISMATCH' : !priceOk ? 'PRICE_MISMATCH' : 'STOCK_MISMATCH'
  return finish(row, status, notes)
}

export function reconcileAll(input: ReconcileInput): { rows: ReconciliationRow[]; aggregates: Aggregates } {
  const rows = input.products.map((p) => reconcileProduct(p, input))
  return { rows, aggregates: aggregate(rows, input) }
}

export function aggregate(rows: ReconciliationRow[], input: Pick<ReconcileInput, 'cissStock' | 'wakeProducts' | 'wakeError'>): Aggregates {
  const statusCounts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<RowStatus, number>
  const agg: Aggregates = {
    whitelist_total: rows.length,
    ciss_found: 0,
    ciss_missing: 0,
    ciss_no_stock_record: 0,
    wake_found: 0,
    wake_missing: 0,
    unit_cento: 0,
    unit_pc: 0,
    unit_un: 0,
    unit_kg: 0,
    unit_unsupported: 0,
    unit_missing: 0,
    unit_raw_distribution: {},
    price_matches: 0,
    price_mismatches: 0,
    stock_matches: 0,
    stock_mismatches: 0,
    stock_unverifiable: 0,
    price_table_matches: 0,
    price_table_mismatches: 0,
    configuration_required: 0,
    errors: 0,
    status_counts: statusCounts,
  }
  const wakeComplete = !input.wakeError && input.wakeProducts !== null

  for (const r of rows) {
    statusCounts[r.status]++
    if (r.status === 'ERROR') agg.errors++
    if (r.status === 'CONFIGURATION_REQUIRED') agg.configuration_required++
    if (r.status === 'CISS_MISSING') agg.ciss_missing++

    const outcome = input.cissStock?.get(r.ciss_product_id)
    if (outcome?.ok) {
      if (!outcome.record.found) {
        agg.ciss_no_stock_record++
      } else {
        const rawKey = outcome.record.unitRaw == null || outcome.record.unitRaw.trim() === '' ? '(vazio)' : outcome.record.unitRaw
        agg.unit_raw_distribution[rawKey] = (agg.unit_raw_distribution[rawKey] ?? 0) + 1
        const u = classifyUnit(outcome.record.unitRaw)
        if (u.kind === 'missing') agg.unit_missing++
        else if (u.kind === 'unsupported') agg.unit_unsupported++
        else if (u.unit === 'CENTO') agg.unit_cento++
        else if (u.unit === 'PC') agg.unit_pc++
        else if (u.unit === 'UN') agg.unit_un++
        else agg.unit_kg++
        if (r.ciss_price !== null) agg.ciss_found++
      }
    }

    if (wakeComplete) {
      if (input.wakeProducts?.has(r.wake_sku)) agg.wake_found++
      else agg.wake_missing++
    }

    if (r.price_match === true) agg.price_matches++
    else if (r.price_match === false) agg.price_mismatches++
    if (r.stock_match === true) agg.stock_matches++
    else if (r.stock_match === false) agg.stock_mismatches++
    if (r.error?.startsWith('estoque Wake nao verificavel')) agg.stock_unverifiable++
    if (r.price_table_match === true) agg.price_table_matches++
    else if (r.price_table_match === false) agg.price_table_mismatches++
  }
  return agg
}
