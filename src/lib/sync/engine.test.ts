import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { moneyRound } from '../units'

// Testes de integracao do motor de sync (§16 do FASE B) -- cobrem o que os
// testes puros de pricing/engine.ts e inventory/engine.ts NAO cobrem:
// como syncPrices()/syncStock() usam calculateUnitPrice()/calculateUnitStock()
// dentro do fluxo real (runSync), incluindo:
//  - os caminhos fail-closed (ok:false) gravando status='failed' em
//    sync_run_items com ZERO escrita no Wake (§1/§5);
//  - a persistencia de unit_raw/unit_normalized/unit_class/unit_resolution_status
//    em sync_product_state (§14);
//  - a busca UNICA de estoque+unit no CISS compartilhada entre preco e
//    estoque, mesmo numa run kind='price' (§13).
//
// Usa um banco SQLite real (arquivo temporario, migrado com as mesmas
// migrations de producao) -- so CISS (price-provider/stock) e mockado; Wake
// nunca e chamado porque todo teste roda em dryRun=true (nenhuma escrita
// no Wake acontece nesse modo, ver src/lib/sync/engine.ts).

// `server-only` recusa import fora de condicao `react-server` (ver
// package.json do pacote) -- o worker roda com `tsx --conditions=react-server`,
// mas vitest nao; mockar como no-op evita depender de config global so
// pra este teste de integracao.
vi.mock('server-only', () => ({}))

const mockGetRetailPrices = vi.fn<(ids: string[]) => Promise<Map<string, number>>>()
const mockFetchStockForProducts =
  vi.fn<(ids: string[], opts: { enterprise: number; location: number }) => Promise<Array<{ productId: string; stock: number; unitRaw?: string | null; noRecord?: boolean }>>>()

vi.mock('../ciss/price-provider', () => ({
  getActivePriceProvider: () => ({ getRetailPrices: mockGetRetailPrices }),
}))

vi.mock('../ciss/stock', () => ({
  fetchStockForProducts: (...args: [string[], { enterprise: number; location: number }]) => mockFetchStockForProducts(...args),
}))

// FASE B.1 (PROBLEMA 3): espioes sobre os escritores reais do Wake --
// mantem as classes de erro reais (WakeClientError etc, usadas com
// `instanceof` dentro de src/lib/sync/engine.ts) via importActual, so
// substitui as funcoes que fariam chamada de rede. Provam que nenhum
// caminho (DIRECT, KG sem config, CT+FIXADOR_CENTO) manda wholesalePrice
// pro Wake -- WakePriceUpdateItem nem tem esse campo no tipo (ver
// src/lib/wake/client.ts), entao a garantia e estrutural, nao so
// comportamental; estes testes comprovam o payload de fato.
type WakeStockAck = { produtoVarianteId?: number; sku?: string; resultado?: boolean; detalhes?: string }
const mockUpdateWakePrices = vi.fn<(items: Array<{ identificador: string; precoDe?: number; precoPor: number; precoCusto?: number }>) => Promise<unknown>>()
const mockUpdateWakeStock =
  vi.fn<
    (items: Array<{ identificador: string; listaEstoque: Array<{ produtoVarianteId: number; centroDistribuicaoId: number; estoqueFisico: number }> }>) => Promise<{
      produtosAtualizados: WakeStockAck[]
      produtosNaoAtualizados: WakeStockAck[]
    }>
  >()
const mockGetWakeProductBySku = vi.fn<(sku: string) => Promise<{ precoPor?: number } | null>>()
const mockGetWakePriceTableProducts = vi.fn<(tabelaPrecoId: number, params?: { pagina?: number; quantidadeRegistros?: number }) => Promise<Array<{ sku: string; precoDe: number; precoPor: number }>>>()
const mockAddWakePriceTableProducts = vi.fn<(tabelaPrecoId: number, items: Array<{ sku: string; precoDe: number; precoPor: number }>) => Promise<void>>()
const mockUpdateWakePriceTableProducts = vi.fn<(tabelaPrecoId: number, items: Array<{ sku: string; precoDe: number; precoPor: number }>) => Promise<void>>()

vi.mock('../wake/client', async () => {
  const actual = await vi.importActual<typeof import('../wake/client')>('../wake/client')
  return {
    ...actual,
    updateWakePrices: (...args: Parameters<typeof mockUpdateWakePrices>) => mockUpdateWakePrices(...args),
    updateWakeStock: (...args: Parameters<typeof mockUpdateWakeStock>) => mockUpdateWakeStock(...args),
    getWakeProductBySku: (...args: Parameters<typeof mockGetWakeProductBySku>) => mockGetWakeProductBySku(...args),
    getWakePriceTableProducts: (...args: Parameters<typeof mockGetWakePriceTableProducts>) => mockGetWakePriceTableProducts(...args),
    addWakePriceTableProducts: (...args: Parameters<typeof mockAddWakePriceTableProducts>) => mockAddWakePriceTableProducts(...args),
    updateWakePriceTableProducts: (...args: Parameters<typeof mockUpdateWakePriceTableProducts>) => mockUpdateWakePriceTableProducts(...args),
  }
})

// FASE B.4 §3/§4: nao existe campo de commercialPolicyOverride por produto
// no banco ainda (ver src/lib/units/compute.ts) -- entao "CT +
// NoCommercialPolicy" so e alcancavel via runSync() interceptando
// calculateUnitPrice() neste ponto. `unitPriceOverride`, quando setado por um
// teste, recebe o input original + o resultado default (calculado pela
// implementacao REAL, capturada 1x via importActual) e pode recalcular com
// commercialPolicyOverride pra simular o override que o banco ainda nao
// persiste -- nunca so troca o campo `policy` isolado, senao retailPrice
// ficaria inconsistente (markup de FIXADOR_CENTO sem a policy real). O gate
// exercitado em sync/engine.ts (`priceResult.policy === 'FIXADOR_CENTO'`)
// continua sendo o codigo de producao real; so a origem da policy e
// substituida.
type CalcInput = Parameters<typeof import('../pricing/engine').calculateUnitPrice>[0]
type CalcResult = ReturnType<typeof import('../pricing/engine').calculateUnitPrice>
type UnitPriceOverride = (input: CalcInput, defaultResult: CalcResult) => CalcResult
let unitPriceOverride: UnitPriceOverride | null = null
// Exposto pra testes recalcularem com um input diferente (ex:
// commercialPolicyOverride) sem passar pelo wrapper mockado abaixo --
// evita recursao caso o override chame calculateUnitPrice() de novo.
let actualCalculateUnitPrice: typeof import('../pricing/engine').calculateUnitPrice
vi.mock('../pricing/engine', async () => {
  const actual = await vi.importActual<typeof import('../pricing/engine')>('../pricing/engine')
  actualCalculateUnitPrice = actual.calculateUnitPrice
  return {
    ...actual,
    calculateUnitPrice: (input: CalcInput) => {
      const result = actual.calculateUnitPrice(input)
      return unitPriceOverride ? unitPriceOverride(input, result) : result
    },
  }
})

let db: typeof import('../db').db
let schema: typeof import('../db').schema
let runSync: typeof import('./engine').runSync
let dbPath: string

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `casa-hub-engine-test-${process.pid}-${Date.now()}.db`)
  process.env.DATABASE_PATH = dbPath

  const migrateSqlite = new Database(dbPath)
  migrateSqlite.pragma('journal_mode = WAL')
  migrate(drizzle(migrateSqlite), { migrationsFolder: path.join(process.cwd(), 'drizzle') })
  migrateSqlite.close()

  ;({ db, schema } = await import('../db'))
  ;({ runSync } = await import('./engine'))
})

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + suffix)
    } catch {
      /* melhor esforco -- arquivo temporario de teste */
    }
  }
})

beforeEach(async () => {
  await db.delete(schema.syncRunItems)
  await db.delete(schema.syncProductState)
  await db.delete(schema.syncRuns)
  await db.delete(schema.productSaleUnitConfig)
  await db.delete(schema.managedProducts)
  await db.delete(schema.jobLocks)
  mockGetRetailPrices.mockReset()
  mockFetchStockForProducts.mockReset()
  process.env.WAKE_CD_ID = '25'

  // Escritores Wake reais -- so tem efeito em testes com dryRun:false
  // (PROBLEMA 3, abaixo); defaults inocuos aqui pra nao quebrar os testes
  // dry-run existentes acima, que nunca chamam nenhuma dessas funcoes.
  mockUpdateWakePrices.mockReset().mockResolvedValue({})
  mockUpdateWakeStock.mockReset().mockResolvedValue({ produtosAtualizados: [], produtosNaoAtualizados: [] })
  mockGetWakeProductBySku.mockReset().mockResolvedValue(null)
  mockGetWakePriceTableProducts.mockReset().mockResolvedValue([])
  mockAddWakePriceTableProducts.mockReset().mockResolvedValue(undefined)
  mockUpdateWakePriceTableProducts.mockReset().mockResolvedValue(undefined)
  unitPriceOverride = null

  // Os 5 REQUIRED_UNCONFIRMED_KEYS (ver src/lib/settings.ts) -- so
  // necessarios pra dryRun:false passar por checkRequiredUnconfirmed() sem
  // recusar a run; nao afetam os testes dry-run existentes (que ignoram
  // "missing").
  process.env.WAKE_STOCK_CONTROL_MODE = 'fstore'
  process.env.WAKE_PRICE_TABLE_ID = '74'
  process.env.WAKE_PROMOTION_ID = '10365'
  process.env.CSV_IDENTIFIER_TYPE = 'sku'
})

let nextCissId = 1
async function insertProduct(overrides: Partial<typeof schema.managedProducts.$inferInsert> = {}) {
  const n = nextCissId++
  const [row] = await db
    .insert(schema.managedProducts)
    .values({
      cissProductId: `ciss-${n}`,
      wakeProductVariantId: String(1000 + n),
      wakeSku: `SKU-${n}`,
      active: true,
      ...overrides,
    })
    .returning()
  if (!row) throw new Error('insertProduct falhou')
  return row
}

describe('runSync -- integracao com UnitStrategies (§13/§14/§16)', () => {
  it('DIRECT (PC): 1:1 sem markup, persiste unit_class=DIRECT e status OK', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-PC' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 12.5]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 7, unitRaw: 'PC' }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: true })
    expect(result.failedProducts).toBe(0)
    expect(result.changedProducts).toBe(2) // preco + estoque

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const priceItem = items.find((i) => i.field === 'unit_price')
    const stockItem = items.find((i) => i.field === 'stock')
    expect(priceItem?.status).toBe('planned')
    expect(priceItem?.targetNewValue).toBe(12.5)
    expect(stockItem?.status).toBe('planned')
    expect(stockItem?.targetNewValue).toBe(7)

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.unitClass).toBe('DIRECT')
    expect(state?.unitResolutionStatus).toBe('OK')
    expect(state?.calculatedWakeUnitPrice).toBe(12.5)
    expect(state?.calculatedWakeStock).toBe(7)
  })

  it('HUNDRED (CT): converte cento->unitario com markup de 20% e estoque com STOCK_PERCENT', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-CT' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: true })
    expect(result.failedProducts).toBe(0)

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const priceItem = items.find((i) => i.field === 'unit_price')
    const stockItem = items.find((i) => i.field === 'stock')
    expect(priceItem?.targetNewValue).toBe(3.6) // (300/100) * 1.2
    expect(stockItem?.targetNewValue).toBe(20) // 2 * 100 * 10%

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.unitClass).toBe('HUNDRED')
    expect(state?.unitResolutionStatus).toBe('OK')
  })

  it('PACKAGE_MEASURED (KG) sem config: falha fail-closed com CONFIGURATION_REQUIRED, zero escrita', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-KG' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 17, unitRaw: 'KG' }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: true })
    expect(result.failedProducts).toBe(2) // preco + estoque, ambos failed
    expect(result.appliedProducts).toBe(0)

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    expect(items.every((i) => i.status === 'failed')).toBe(true)
    expect(items.every((i) => i.errorMessage?.includes('CONFIGURATION_REQUIRED'))).toBe(true)

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.unitResolutionStatus).toBe('CONFIGURATION_REQUIRED')
    expect(state?.unitClass).toBeNull()
  })

  it('PACKAGE_MEASURED (KG) com config ativa: multiplica preco e divide estoque pela quantidade configurada', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-KG-CFG' })
    await db.insert(schema.productSaleUnitConfig).values({
      managedProductId: product.id,
      sourceUnit: 'KG',
      quantityPerSaleUnit: 5,
      active: true,
    })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 17, unitRaw: 'KG' }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: true })
    expect(result.failedProducts).toBe(0)

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const priceItem = items.find((i) => i.field === 'unit_price')
    const stockItem = items.find((i) => i.field === 'stock')
    expect(priceItem?.targetNewValue).toBe(50) // 10/kg * 5kg
    expect(stockItem?.targetNewValue).toBe(3) // floor(17/5)

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.unitClass).toBe('PACKAGE_MEASURED')
    expect(state?.unitResolutionStatus).toBe('OK')
  })

  it('UNIT desconhecida (XYZ): falha fail-closed com UNSUPPORTED_UNIT, nunca assume DIRECT', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-XYZ' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: 'XYZ' }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: true })
    expect(result.failedProducts).toBe(2)

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    expect(items.every((i) => i.status === 'failed')).toBe(true)
    expect(items.every((i) => i.errorMessage?.includes('UNSUPPORTED_UNIT'))).toBe(true)

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.unitResolutionStatus).toBe('UNSUPPORTED_UNIT')
  })

  it('busca de estoque+unit no CISS e UNICA por run, compartilhada entre preco e estoque (§13)', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-SHARED' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 12.5]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 7, unitRaw: 'PC' }])

    await runSync({ kind: 'both', trigger: 'manual', dryRun: true })
    expect(mockFetchStockForProducts).toHaveBeenCalledTimes(1)
  })

  it('kind="price" tambem consulta /products/stock (so por causa do unitRaw) -- consequencia aceita do §13', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-PRICE-ONLY' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 12.5]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 7, unitRaw: 'PC' }])

    const result = await runSync({ kind: 'price', trigger: 'manual', dryRun: true })
    expect(mockFetchStockForProducts).toHaveBeenCalledTimes(1)

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    expect(items.some((i) => i.field === 'stock')).toBe(false) // kind='price' nao gera item de estoque
    expect(items.find((i) => i.field === 'unit_price')?.status).toBe('planned')
  })

  it('dry-run nunca conta como aplicado, mesmo com produtos validos e mudanca detectada', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-DRYRUN' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 12.5]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 7, unitRaw: 'PC' }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: true })
    expect(result.appliedProducts).toBe(0)
    expect(result.status).toBe('success')
  })
})

describe('runSync -- isolamento do escritor Wake real (FASE B.1, PROBLEMA 3)', () => {
  it('DIRECT (PC), escrita real: payload do Wake nunca carrega campo de atacado; Tabela 74 NAO e escrita (FASE B.4 §3 -- DIRECT nao tem CommercialPolicy=FIXADOR_CENTO)', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-PC-WRITE' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 12.5]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 7, unitRaw: 'PC' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 12.5 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    expect(mockUpdateWakePrices).toHaveBeenCalledTimes(1)
    expect(mockUpdateWakePrices).toHaveBeenCalledWith([{ identificador: 'SKU-PC-WRITE', precoPor: 12.5 }])

    expect(mockUpdateWakeStock).toHaveBeenCalledTimes(1)
    expect(mockUpdateWakeStock).toHaveBeenCalledWith([
      { identificador: 'SKU-PC-WRITE', listaEstoque: [{ produtoVarianteId: variantId, centroDistribuicaoId: 25, estoqueFisico: 7 }] },
    ])

    // FASE B.4 §3 (BLOQUEIO PRINCIPAL): antes, addWakePriceTableProducts era
    // chamado pra QUALQUER produto so porque WAKE_PRICE_TABLE_ID existia.
    // Agora o gate e priceResult.policy === 'FIXADOR_CENTO' -- DIRECT nunca
    // recebe essa policy (resolveCommercialPolicy('DIRECT') = 'NONE'), entao
    // a Tabela 74 fica de fora.
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()

    expect(result.failedProducts).toBe(0)
    expect(result.appliedProducts).toBe(2) // preco + estoque (Tabela 74 nao participa)
    expect(result.status).toBe('success')
  })

  it('PACKAGE_MEASURED (KG) sem config, escrita real: zero chamada a qualquer escritor Wake (fail-closed)', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-KG-WRITE' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 17, unitRaw: 'KG' }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    expect(result.failedProducts).toBe(2) // preco + estoque
    expect(result.appliedProducts).toBe(0)
    expect(result.status).toBe('failed')

    expect(mockUpdateWakePrices).not.toHaveBeenCalled()
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
  })

  it('HUNDRED (CT + FIXADOR_CENTO), escrita real: wholesalePrice e calculado/persistido mas NUNCA sai no payload do Wake', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-CT-WRITE' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 3.6 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    // precoPor=3.6 (retail com markup de 20%) -- sem qualquer chave de
    // atacado/desconto no payload, mesmo o produto tendo wholesalePrice
    // calculado (2.88, conferido abaixo via sync_product_state).
    expect(mockUpdateWakePrices).toHaveBeenCalledTimes(1)
    expect(mockUpdateWakePrices).toHaveBeenCalledWith([{ identificador: 'SKU-CT-WRITE', precoPor: 3.6 }])

    expect(mockUpdateWakeStock).toHaveBeenCalledTimes(1)
    expect(mockUpdateWakeStock).toHaveBeenCalledWith([
      { identificador: 'SKU-CT-WRITE', listaEstoque: [{ produtoVarianteId: variantId, centroDistribuicaoId: 25, estoqueFisico: 20 }] },
    ])

    expect(mockAddWakePriceTableProducts).toHaveBeenCalledTimes(1)
    expect(mockAddWakePriceTableProducts).toHaveBeenCalledWith(74, [{ sku: 'SKU-CT-WRITE', precoDe: moneyRound(3.6 * 1.3), precoPor: 3.6 }])

    expect(result.failedProducts).toBe(0)
    expect(result.status).toBe('success')

    // Audit trail local prova que o wholesale FOI calculado -- so nunca
    // chega ao Wake (ver asserts acima sobre o payload).
    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.calculatedWakeSpecialPrice).toBe(2.88)
    expect(state?.lastAppliedWakeSpecialPrice).toBe(2.88)
  })

  it('PACKAGE_MEASURED (KG) com config ativa, escrita real: payload do Wake so tem preco/estoque normal, Tabela 74 NAO e escrita (FASE B.4 §3 -- KG nao tem CommercialPolicy=FIXADOR_CENTO)', async () => {
    // Completa a matriz de cobertura do BLOQUEIO C (FASE B.2 §4): DIRECT e
    // HUNDRED+FIXADOR_CENTO ja provados acima com escrita real; falta
    // PACKAGE_MEASURED com config ativa (o unico outro caminho que produz
    // ok:true e chega ate os escritores Wake reais). Preco 10/kg * 5kg/config
    // = 50 (preco normal, NAO e wholesale de FIXADOR_CENTO -- essa policy so
    // se aplica a HUNDRED); estoque floor(17/5)=3.
    const product = await insertProduct({ wakeSku: 'SKU-KG-CFG-WRITE' })
    const variantId = Number(product.wakeProductVariantId)
    await db.insert(schema.productSaleUnitConfig).values({
      managedProductId: product.id,
      sourceUnit: 'KG',
      quantityPerSaleUnit: 5,
      active: true,
    })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 17, unitRaw: 'KG' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 50 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    expect(mockUpdateWakePrices).toHaveBeenCalledTimes(1)
    expect(mockUpdateWakePrices).toHaveBeenCalledWith([{ identificador: 'SKU-KG-CFG-WRITE', precoPor: 50 }])

    expect(mockUpdateWakeStock).toHaveBeenCalledTimes(1)
    expect(mockUpdateWakeStock).toHaveBeenCalledWith([
      { identificador: 'SKU-KG-CFG-WRITE', listaEstoque: [{ produtoVarianteId: variantId, centroDistribuicaoId: 25, estoqueFisico: 3 }] },
    ])

    // FASE B.4 §3 (BLOQUEIO PRINCIPAL): PACKAGE_MEASURED (KG) nunca recebe
    // policy=FIXADOR_CENTO (resolveCommercialPolicy so se aplica a HUNDRED),
    // entao a Tabela 74 fica de fora -- mesmo com WAKE_PRICE_TABLE_ID
    // configurado.
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()

    expect(result.failedProducts).toBe(0)
    expect(result.appliedProducts).toBe(2) // preco + estoque (Tabela 74 nao participa)
    expect(result.status).toBe('success')

    // Audit trail confirma que nao ha wholesale calculado/persistido pra
    // este produto -- FIXADOR_CENTO nunca roda fora de HUNDRED.
    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.calculatedWakeSpecialPrice).toBeNull()
    expect(state?.lastAppliedWakeSpecialPrice).toBeNull()
  })

  it('PACKAGE_MEASURED (MT) com config ativa, escrita real: Tabela 74 NAO e escrita (FASE B.4 §3/§4 -- MT nao tem CommercialPolicy=FIXADOR_CENTO)', async () => {
    // Espelha o teste de KG acima -- prova que a exclusao da Tabela 74 vale
    // pra PACKAGE_MEASURED como um todo (nao so pra KG especificamente).
    // Preco 8/m * 4m/config = 32; estoque floor(9/4)=2.
    const product = await insertProduct({ wakeSku: 'SKU-MT-CFG-WRITE' })
    const variantId = Number(product.wakeProductVariantId)
    await db.insert(schema.productSaleUnitConfig).values({
      managedProductId: product.id,
      sourceUnit: 'MT',
      quantityPerSaleUnit: 4,
      active: true,
    })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 8]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 9, unitRaw: 'MT' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 32 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    expect(mockUpdateWakePrices).toHaveBeenCalledTimes(1)
    expect(mockUpdateWakePrices).toHaveBeenCalledWith([{ identificador: 'SKU-MT-CFG-WRITE', precoPor: 32 }])

    expect(mockUpdateWakeStock).toHaveBeenCalledTimes(1)
    expect(mockUpdateWakeStock).toHaveBeenCalledWith([
      { identificador: 'SKU-MT-CFG-WRITE', listaEstoque: [{ produtoVarianteId: variantId, centroDistribuicaoId: 25, estoqueFisico: 2 }] },
    ])

    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()

    expect(result.failedProducts).toBe(0)
    expect(result.appliedProducts).toBe(2) // preco + estoque (Tabela 74 nao participa)
    expect(result.status).toBe('success')
  })

  it('HUNDRED (CT) + commercialPolicyOverride=NONE, escrita real: Tabela 74 NAO e escrita mesmo sendo HUNDRED (FASE B.4 §3/§4 -- gate e policy, nunca unitClass sozinho)', async () => {
    // Prova o requisito mais sutil do §3: o gate NAO pode ser
    // unitClass === 'HUNDRED'. Precisa ser a decisao comercial centralizada
    // (priceResult.policy). Hoje nao existe campo de override por produto no
    // banco (ver src/lib/units/compute.ts, comentario sobre ausencia dessa
    // coluna) -- entao simulamos aqui, no nivel de integracao, via
    // unitPriceOverride (ver vi.mock('../pricing/engine') no topo do
    // arquivo), forcando policy='NONE' pra este produto especifico. O gate
    // exercitado (`priceResult.policy === 'FIXADOR_CENTO'` em
    // sync/engine.ts) e o codigo de producao de verdade; so a origem da
    // policy e substituida.
    unitPriceOverride = (input, result) => (result.ok && result.unitClass === 'HUNDRED' ? actualCalculateUnitPrice({ ...input, commercialPolicyOverride: 'NONE' }) : result)

    const product = await insertProduct({ wakeSku: 'SKU-CT-NOPOLICY-WRITE' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 3 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    expect(mockUpdateWakePrices).toHaveBeenCalledTimes(1)
    expect(mockUpdateWakePrices).toHaveBeenCalledWith([{ identificador: 'SKU-CT-NOPOLICY-WRITE', precoPor: 3 }])

    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()

    expect(result.failedProducts).toBe(0)
    expect(result.appliedProducts).toBe(2) // preco + estoque (Tabela 74 nao participa)
    expect(result.status).toBe('success')
  })
})

describe('runSync -- linha de estoque ausente no CISS nunca vira DIRECT nem escrita silenciosa (FASE B.1, PROBLEMA 7)', () => {
  it('produto sem NENHUM saldo ja registrado (noRecord=true): preco cai em UNSUPPORTED_UNIT, estoque cai em NO_STOCK_RECORD (BLOQUEIO E), zero escrita real no Wake', async () => {
    // Espelha fetchOneProductStock() em src/lib/ciss/stock.ts (linha 77):
    // quando o CISS responde 200 mas sem nenhuma linha pro produto, o
    // cliente devolve { stock: 0, noRecord: true, unitRaw: null } -- NUNCA
    // undefined (fetchStockForProducts sempre devolve 1 linha por produto
    // pedido). syncPrices() nao trata noRecord especificamente: unitRaw vem
    // null, resolveUnit() falha, cai em UNSUPPORTED_UNIT (igual UNIT
    // desconhecida). syncStock() (BLOQUEIO E, FASE B.2) intercepta
    // noRecord ANTES de tentar resolver a UNIT, gerando o status distinto
    // NO_STOCK_RECORD -- o operador nao confunde mais "sem registro no ERP"
    // com "UNIT nao reconhecida".
    const product = await insertProduct({ wakeSku: 'SKU-NORECORD' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 0, noRecord: true, unitRaw: null }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    expect(result.failedProducts).toBe(2) // preco + estoque
    expect(result.appliedProducts).toBe(0)
    expect(result.status).toBe('failed')

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const priceItem = items.find((i) => i.field === 'unit_price')
    const stockItem = items.find((i) => i.field === 'stock')
    expect(priceItem?.status).toBe('failed')
    expect(priceItem?.errorMessage).toContain('UNSUPPORTED_UNIT')
    expect(priceItem?.errorMessage).toContain('unit_raw=null')
    expect(stockItem?.status).toBe('failed')
    expect(stockItem?.errorMessage).toContain('Sem registro de estoque no ERP')
    expect(stockItem?.errorMessage).not.toContain('UNSUPPORTED_UNIT')

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    // syncStock() roda depois de syncPrices() e e a ultima gravacao em
    // sync_product_state pra este produto -- por isso o estado final
    // reflete NO_STOCK_RECORD (o resultado do BLOQUEIO E), nao o
    // UNSUPPORTED_UNIT que syncPrices() gravou primeiro.
    expect(state?.unitResolutionStatus).toBe('NO_STOCK_RECORD')
    expect(state?.unitClass).toBeNull()

    expect(mockUpdateWakePrices).not.toHaveBeenCalled()
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
  })

  it('produto inteiramente ausente da resposta do CISS (mock nao devolve linha alguma): preco e estoque falham por caminhos distintos, nenhum e ignorado silenciosamente', async () => {
    // Caso defensivo: mesmo que fetchStockForProducts() na producao sempre
    // devolva 1 linha por produto pedido (ver stock.ts), o motor de sync
    // (engine.ts) nao depende dessa garantia -- stockByProduct.get() usa
    // Map, que devolve undefined pra chave ausente. Prova que, mesmo nesse
    // cenario mais extremo, nada e aplicado ao Wake e nada e descartado
    // sem registro: preco cai em UNIT nao processavel (unitRaw vira null
    // via `stockRow?.unitRaw ?? null`), estoque cai no caminho MAIS cedo e
    // MAIS especifico "Sem leitura de estoque CISS" (erpStock undefined).
    const product = await insertProduct({ wakeSku: 'SKU-ABSENT' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    expect(result.failedProducts).toBe(2)
    expect(result.appliedProducts).toBe(0)

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const priceItem = items.find((i) => i.field === 'unit_price')
    const stockItem = items.find((i) => i.field === 'stock')
    expect(priceItem?.status).toBe('failed')
    expect(priceItem?.errorMessage).toContain('UNSUPPORTED_UNIT')
    expect(priceItem?.errorMessage).toContain('unit_raw=null')
    expect(stockItem?.status).toBe('failed')
    expect(stockItem?.errorMessage).toMatch(/^Sem leitura de estoque CISS para ciss_product_id=/)

    expect(mockUpdateWakePrices).not.toHaveBeenCalled()
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
  })
})
