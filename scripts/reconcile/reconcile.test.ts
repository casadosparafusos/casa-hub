import { describe, expect, it } from 'vitest'
import type { CissStockOutcome, CissStockRecord } from './ciss-reader'
import type { ManagedProductRow } from './db-readonly'
import { reconcileAll, reconcileProduct, type ReconcileInput } from './reconcile'
import type { WakePriceTableEntry, WakeProductSnapshot, WakeStockReadStatus } from './wake-reader'

function product(id: string, variant = `9${id}`, sku = `SKU${id}`): ManagedProductRow {
  return { id: Number(id), cissProductId: id, wakeVariantId: variant, wakeSku: sku }
}

function stock(id: string, unitRaw: string | null, quantity: number, found = true): CissStockOutcome {
  const record: CissStockRecord = {
    productId: id,
    found,
    unitRaw: found ? unitRaw : null,
    description: null,
    reference: null,
    enterprise: 2,
    location: 2,
    quantity: found ? quantity : 0,
    locationPresent: found,
    companies: found ? [{ enterprise_id: 2, stocks: [{ location_id: 2, quantity }] }] : [],
  }
  return { ok: true, record }
}

function wake(
  p: ManagedProductRow,
  precoPor: number | null,
  stockCd: number | null,
  stockStatus: WakeStockReadStatus = stockCd === null ? 'no_cd_entry' : 'ok',
): WakeProductSnapshot {
  return { variantId: Number(p.wakeVariantId), sku: p.wakeSku, precoDe: null, precoPor, stockCd, stockStatus, reservedCd: 0, valido: true, exibirSite: true }
}

function table(p: ManagedProductRow, precoPor: number): WakePriceTableEntry {
  return { sku: p.wakeSku, variantId: Number(p.wakeVariantId), precoDe: Math.round(precoPor * 130) / 100, precoPor, dataInicio: null, dataFim: null }
}

function baseInput(products: ManagedProductRow[]): ReconcileInput {
  return {
    products,
    cissPrices: new Map(),
    cissStock: new Map(),
    cissError: null,
    wakeProducts: new Map(),
    wakeError: null,
    wakeTable: new Map(),
    tableError: null,
    packageWeights: new Map(),
  }
}

describe('reconcileProduct', () => {
  const p = product('100')

  function withHundred(precoPor: number | null, stockCd: number | null, tablePreco = 0.3): ReconcileInput {
    const input = baseInput([p])
    input.cissPrices!.set('100', 25)
    input.cissStock!.set('100', stock('100', 'CT', 36.69))
    input.wakeProducts!.set(p.wakeSku, wake(p, precoPor, stockCd))
    input.wakeTable!.set(p.wakeSku, table(p, tablePreco))
    return input
  }

  it('CT (HUNDRED) batendo = MATCH', () => {
    const r = reconcileProduct(p, withHundred(0.3, 366))
    expect(r).toMatchObject({
      status: 'MATCH',
      unit: 'HUNDRED',
      ciss_price: 25,
      ciss_stock: 36.69,
      expected_retail_price: 0.3,
      expected_wholesale_price: 0.24,
      expected_stock: 366,
      wake_current_price: 0.3,
      wake_current_stock: 366,
      price_match: true,
      stock_match: true,
      price_table_expected: 0.3,
      price_table_actual: 0.3,
      price_table_match: true,
      error: null,
    })
  })

  it('mismatch de preco', () => {
    const r = reconcileProduct(p, withHundred(25, 366))
    expect(r.status).toBe('PRICE_MISMATCH')
    expect(r.price_match).toBe(false)
    expect(r.stock_match).toBe(true)
  })

  it('mismatch so na tabela de preco tambem e PRICE_MISMATCH', () => {
    const r = reconcileProduct(p, withHundred(0.3, 366, 0.5))
    expect(r.status).toBe('PRICE_MISMATCH')
    expect(r.price_match).toBe(true)
    expect(r.price_table_match).toBe(false)
  })

  it('mismatch de estoque', () => {
    const r = reconcileProduct(p, withHundred(0.3, 3669))
    expect(r.status).toBe('STOCK_MISMATCH')
    expect(r.stock_match).toBe(false)
  })

  it('mismatch de preco e estoque', () => {
    expect(reconcileProduct(p, withHundred(25, 36)).status).toBe('PRICE_AND_STOCK_MISMATCH')
  })

  it('PC (DIRECT): sem conversao de HUNDRED', () => {
    const input = baseInput([p])
    input.cissPrices!.set('100', 12.5)
    input.cissStock!.set('100', stock('100', 'PC', 7.9))
    input.wakeProducts!.set(p.wakeSku, wake(p, 12.5, 7))
    input.wakeTable!.set(p.wakeSku, table(p, 12.5))
    const r = reconcileProduct(p, input)
    expect(r).toMatchObject({ status: 'MATCH', unit: 'DIRECT', expected_retail_price: 12.5, expected_wholesale_price: null, expected_stock: 7 })
  })

  it('PC com a Wake no formato HUNDRED = PRICE_AND_STOCK_MISMATCH (nao aplica FIXADOR_CENTO em DIRECT)', () => {
    const input = baseInput([p])
    input.cissPrices!.set('100', 12.5)
    input.cissStock!.set('100', stock('100', 'PC', 7))
    input.wakeProducts!.set(p.wakeSku, wake(p, 0.15, 70))
    input.wakeTable!.set(p.wakeSku, table(p, 0.15))
    expect(reconcileProduct(p, input).status).toBe('PRICE_AND_STOCK_MISMATCH')
  })

  it.each(['JG', 'PR', 'CJ', 'RL', 'KT', 'CX', 'LT', 'PL'])('%s tambem e DIRECT (1:1, sem conversao)', (raw) => {
    const input = baseInput([p])
    input.cissPrices!.set('100', 2.07)
    input.cissStock!.set('100', stock('100', raw, 1894))
    input.wakeProducts!.set(p.wakeSku, wake(p, 2.07, 1894))
    input.wakeTable!.set(p.wakeSku, table(p, 2.07))
    expect(reconcileProduct(p, input)).toMatchObject({ status: 'MATCH', unit: 'DIRECT', expected_stock: 1894 })
  })

  it('KG sem embalagem = CONFIGURATION_REQUIRED', () => {
    const input = baseInput([p])
    input.cissPrices!.set('100', 30)
    input.cissStock!.set('100', stock('100', 'KG', 12.5))
    input.wakeProducts!.set(p.wakeSku, wake(p, 30, 12))
    const r = reconcileProduct(p, input)
    expect(r.status).toBe('CONFIGURATION_REQUIRED')
    expect(r.expected_retail_price).toBeNull()
  })

  it('KG com embalagem = compara pela caixa', () => {
    const input = baseInput([p])
    input.packageWeights.set('100', 5)
    input.cissPrices!.set('100', 30)
    input.cissStock!.set('100', stock('100', 'KG', 12.5))
    input.wakeProducts!.set(p.wakeSku, wake(p, 150, 2))
    input.wakeTable!.set(p.wakeSku, table(p, 150))
    expect(reconcileProduct(p, input)).toMatchObject({ status: 'MATCH', package_weight_kg: 5, expected_stock: 2 })
  })

  it('MT sem embalagem = CONFIGURATION_REQUIRED', () => {
    const input = baseInput([p])
    input.cissPrices!.set('100', 10)
    input.cissStock!.set('100', stock('100', 'MT', 50))
    const r = reconcileProduct(p, input)
    expect(r.status).toBe('CONFIGURATION_REQUIRED')
  })

  it('unit desconhecida = UNSUPPORTED_UNIT', () => {
    const input = baseInput([p])
    input.cissPrices!.set('100', 30)
    input.cissStock!.set('100', stock('100', 'MILHEIRO', 10))
    const r = reconcileProduct(p, input)
    expect(r.status).toBe('UNSUPPORTED_UNIT')
    expect(r.unit_raw).toBe('MILHEIRO')
    expect(r.unit).toBeNull()
  })

  it('unit ausente = UNSUPPORTED_UNIT', () => {
    const input = baseInput([p])
    input.cissPrices!.set('100', 30)
    input.cissStock!.set('100', stock('100', null, 10))
    expect(reconcileProduct(p, input).status).toBe('UNSUPPORTED_UNIT')
  })

  it('CISS sem registro de estoque = CISS_MISSING', () => {
    const input = baseInput([p])
    input.cissPrices!.set('100', 30)
    input.cissStock!.set('100', stock('100', null, 0, false))
    const r = reconcileProduct(p, input)
    expect(r.status).toBe('CISS_MISSING')
    expect(r.error).toContain('data:[]')
  })

  it('CISS sem preco = CISS_MISSING', () => {
    const input = baseInput([p])
    input.cissStock!.set('100', stock('100', 'CT', 10))
    expect(reconcileProduct(p, input).status).toBe('CISS_MISSING')
    input.cissPrices!.set('100', null)
    expect(reconcileProduct(p, input).error).toContain('retail_price null')
  })

  it('SKU fora da Wake = WAKE_MISSING', () => {
    const input = baseInput([p])
    input.cissPrices!.set('100', 25)
    input.cissStock!.set('100', stock('100', 'CT', 10))
    const r = reconcileProduct(p, input)
    expect(r.status).toBe('WAKE_MISSING')
    expect(r.expected_retail_price).toBe(0.3)
  })

  it('leitura Wake abortada = ERROR (nunca WAKE_MISSING)', () => {
    const input = baseInput([p])
    input.cissPrices!.set('100', 25)
    input.cissStock!.set('100', stock('100', 'CT', 10))
    input.wakeProducts = null
    input.wakeError = 'Wake respondeu 429'
    const r = reconcileProduct(p, input)
    expect(r.status).toBe('ERROR')
    expect(r.error).toContain('429')
  })

  it('erro de leitura CISS por produto = ERROR', () => {
    const input = baseInput([p])
    input.cissStock!.set('100', { ok: false, error: 'CISS 500 apos 2 tentativas' })
    expect(reconcileProduct(p, input)).toMatchObject({ status: 'ERROR', error: 'CISS 500 apos 2 tentativas' })
  })

  it('tabela nao lida: price_table_match null, status decidido pelo resto', () => {
    const input = withHundred(0.3, 366)
    input.wakeTable = null
    input.tableError = 'Wake respondeu 404'
    const r = reconcileProduct(p, input)
    expect(r.status).toBe('MATCH')
    expect(r.price_table_match).toBeNull()
    expect(r.error).toContain('tabela de preco nao lida')
  })

  it('SKU ausente na tabela = price_table_match false', () => {
    const input = withHundred(0.3, 366)
    input.wakeTable = new Map()
    const r = reconcileProduct(p, input)
    expect(r.status).toBe('PRICE_MISMATCH')
    expect(r.price_table_match).toBe(false)
  })

  it('estoque Wake sem o campo estoque[] (no_field) = ERROR explicito, nunca STOCK_MISMATCH', () => {
    const input = withHundred(0.3, null)
    input.wakeProducts!.set(p.wakeSku, wake(p, 0.3, null, 'no_field'))
    const r = reconcileProduct(p, input)
    expect(r.status).toBe('ERROR')
    expect(r.stock_match).toBeNull()
    expect(r.price_match).toBe(true) // preco continua reconciliado
    expect(r.expected_stock).toBe(366)
    expect(r.error).toContain('estoque Wake nao verificavel (no_field)')
  })

  it('estoque[] sem entrada do CD (no_cd_entry) = ERROR, nunca STOCK_MISMATCH', () => {
    const r = reconcileProduct(p, withHundred(25, null))
    expect(r.status).toBe('ERROR')
    expect(r.stock_match).toBeNull()
    expect(r.price_match).toBe(false)
    expect(r.error).toContain('estoque Wake nao verificavel (no_cd_entry)')
    expect(r.error).toContain('preco DIVERGE')
  })

  it('estoqueFisico invalido (invalid_value) = ERROR', () => {
    const input = withHundred(0.3, null)
    input.wakeProducts!.set(p.wakeSku, wake(p, 0.3, null, 'invalid_value'))
    expect(reconcileProduct(p, input)).toMatchObject({ status: 'ERROR', stock_match: null })
  })

  it('variant id divergente e anotado', () => {
    const input = withHundred(0.3, 366)
    input.wakeProducts!.set(p.wakeSku, { ...wake(p, 0.3, 366), variantId: 1 })
    expect(reconcileProduct(p, input).error).toContain('difere do cadastrado')
  })
})

describe('reconcileAll / agregados', () => {
  it('conta unidades, matches e status', () => {
    const a = product('1')
    const b = product('2')
    const c = product('3')
    const d = product('4')
    const e = product('5')
    const input = baseInput([a, b, c, d, e])
    input.cissPrices!.set('1', 25).set('2', 12.5).set('3', 30).set('4', 10)
    input.cissStock!.set('1', stock('1', 'CT', 36.69))
    input.cissStock!.set('2', stock('2', 'PC', 7))
    input.cissStock!.set('3', stock('3', 'KG', 10))
    input.cissStock!.set('4', stock('4', 'XYZ', 1))
    input.cissStock!.set('5', stock('5', null, 0, false))
    input.wakeProducts!.set(a.wakeSku, wake(a, 0.3, 366))
    input.wakeProducts!.set(b.wakeSku, wake(b, 12.5, 5))
    input.wakeTable!.set(a.wakeSku, table(a, 0.3))
    input.wakeTable!.set(b.wakeSku, table(b, 12.5))

    const { rows, aggregates } = reconcileAll(input)
    expect(rows.map((r) => r.status)).toEqual(['MATCH', 'STOCK_MISMATCH', 'CONFIGURATION_REQUIRED', 'UNSUPPORTED_UNIT', 'CISS_MISSING'])
    expect(aggregates).toMatchObject({
      whitelist_total: 5,
      ciss_found: 4,
      ciss_missing: 1,
      ciss_no_stock_record: 1,
      wake_found: 2,
      wake_missing: 3,
      unit_hundred: 1,
      unit_direct: 1,
      unit_package_measured: 1,
      unit_unsupported: 1,
      unit_missing: 0,
      price_matches: 2,
      price_mismatches: 0,
      stock_matches: 1,
      stock_mismatches: 1,
      price_table_matches: 2,
      price_table_mismatches: 0,
      configuration_required: 1,
      errors: 0,
    })
    expect(aggregates.unit_raw_distribution).toEqual({ CT: 1, PC: 1, KG: 1, XYZ: 1 })
    expect(aggregates.status_counts.MATCH).toBe(1)
  })

  it('formato de estoque indisponivel em massa: zero STOCK_MISMATCH, tudo stock_unverifiable', () => {
    const ps = ['1', '2', '3'].map((id) => product(id))
    const input = baseInput(ps)
    for (const x of ps) {
      input.cissPrices!.set(x.cissProductId, 25)
      input.cissStock!.set(x.cissProductId, stock(x.cissProductId, 'CT', 10))
      input.wakeProducts!.set(x.wakeSku, wake(x, 0.3, null, 'no_field'))
      input.wakeTable!.set(x.wakeSku, table(x, 0.3))
    }
    const { rows, aggregates } = reconcileAll(input)
    expect(rows.every((r) => r.status === 'ERROR')).toBe(true)
    expect(aggregates.stock_mismatches).toBe(0)
    expect(aggregates.stock_matches).toBe(0)
    expect(aggregates.stock_unverifiable).toBe(3)
    expect(aggregates.status_counts.STOCK_MISMATCH).toBe(0)
    expect(aggregates.price_matches).toBe(3)
  })

  it('Wake incompleta: wake_found/wake_missing nao sao contados', () => {
    const a = product('1')
    const input = baseInput([a])
    input.cissPrices!.set('1', 25)
    input.cissStock!.set('1', stock('1', 'CT', 1))
    input.wakeProducts = null
    input.wakeError = '429'
    const { aggregates } = reconcileAll(input)
    expect(aggregates.wake_found).toBe(0)
    expect(aggregates.wake_missing).toBe(0)
    expect(aggregates.errors).toBe(1)
  })
})
