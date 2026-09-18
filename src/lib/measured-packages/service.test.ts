import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Mesmo motivo do mock em src/lib/sync/engine.test.ts: `server-only` recusa
// import fora da condicao `react-server`, que o vitest nao usa.
vi.mock('server-only', () => ({}))

type StockRow = { productId: string; stock: number; unitRaw?: string | null; noRecord?: boolean }
const mockFetchStockForProducts = vi.fn<(ids: string[], opts: { enterprise: number; location: number }) => Promise<StockRow[]>>()
vi.mock('../ciss/stock', () => ({
  fetchStockForProducts: (...args: [string[], { enterprise: number; location: number }]) => mockFetchStockForProducts(...args),
}))

let db: typeof import('../db').db
let schema: typeof import('../db').schema
let upsertBySku: typeof import('./service').upsertBySku
let deactivateConfig: typeof import('./service').deactivateConfig
let reactivateConfig: typeof import('./service').reactivateConfig
let listConfigs: typeof import('./service').listConfigs
let listPendingProducts: typeof import('./service').listPendingProducts
let MeasuredPackageError: typeof import('./types').MeasuredPackageError
let MeasuredPackageInfraError: typeof import('./types').MeasuredPackageInfraError
let dbPath: string

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `casa-hub-measured-packages-service-test-${process.pid}-${Date.now()}.db`)
  process.env.DATABASE_PATH = dbPath

  const migrateSqlite = new Database(dbPath)
  migrateSqlite.pragma('journal_mode = WAL')
  migrate(drizzle(migrateSqlite), { migrationsFolder: path.join(process.cwd(), 'drizzle') })
  migrateSqlite.close()

  ;({ db, schema } = await import('../db'))
  ;({ upsertBySku, deactivateConfig, reactivateConfig, listConfigs, listPendingProducts } = await import('./service'))
  ;({ MeasuredPackageError, MeasuredPackageInfraError } = await import('./types'))
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
  await db.delete(schema.productSaleUnitConfigEvents)
  await db.delete(schema.productSaleUnitConfig)
  await db.delete(schema.syncProductState)
  await db.delete(schema.managedProducts)
  mockFetchStockForProducts.mockReset()
})

let nextId = 1
async function insertProduct(overrides: Partial<typeof schema.managedProducts.$inferInsert> = {}) {
  const n = nextId++
  const [row] = await db
    .insert(schema.managedProducts)
    .values({
      cissProductId: `ciss-${n}`,
      wakeProductVariantId: String(2000 + n),
      wakeSku: `SKU-${n}`,
      active: true,
      ...overrides,
    })
    .returning()
  if (!row) throw new Error('insertProduct falhou')
  return row
}

describe('upsertBySku -- FASE E §4 (UNIT sempre resolvido no CISS, nunca digitado)', () => {
  it('cria config nova quando CISS confirma UNIT=KG', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-KG-1' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 180, unitRaw: 'KG' }])

    const config = await upsertBySku({ sku: 'SKU-KG-1', quantity: 18, actor: 'tester' })
    expect(config).toMatchObject({ sourceUnit: 'KG', quantityPerSaleUnit: 18, active: true, updatedBy: 'tester' })

    const events = await db.select().from(schema.productSaleUnitConfigEvents).where(eq(schema.productSaleUnitConfigEvents.managedProductId, product.id))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ action: 'CREATE', sourceUnit: 'KG', newQuantityPerSaleUnit: 18, origin: 'MANUAL', actor: 'tester' })
  })

  it('cria config nova quando CISS confirma UNIT=MT', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-MT-1' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 50, unitRaw: 'MT' }])

    const config = await upsertBySku({ sku: 'SKU-MT-1', quantity: 5, actor: 'tester' })
    expect(config).toMatchObject({ sourceUnit: 'MT', quantityPerSaleUnit: 5 })
  })

  it('UNIT e normalizado (trim+uppercase) antes de comparar com KG/MT', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-TRIM' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: ' kg ' }])

    const config = await upsertBySku({ sku: 'SKU-TRIM', quantity: 2, actor: 'tester' })
    expect(config.sourceUnit).toBe('KG')
  })

  it('edita config ativa existente in place -- nunca cria uma segunda linha ativa', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-EDIT' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 100, unitRaw: 'KG' }])
    const first = await upsertBySku({ sku: 'SKU-EDIT', quantity: 10, actor: 'tester' })

    const second = await upsertBySku({ sku: 'SKU-EDIT', quantity: 20, actor: 'tester2' })
    expect(second.id).toBe(first.id)
    expect(second.quantityPerSaleUnit).toBe(20)
    expect(second.updatedBy).toBe('tester2')

    const active = await db.select().from(schema.productSaleUnitConfig).where(eq(schema.productSaleUnitConfig.managedProductId, product.id))
    expect(active.filter((c) => c.active)).toHaveLength(1)

    const events = await db.select().from(schema.productSaleUnitConfigEvents).where(eq(schema.productSaleUnitConfigEvents.managedProductId, product.id))
    expect(events.map((e) => e.action)).toEqual(['CREATE', 'UPDATE'])
    expect(events[1]).toMatchObject({ oldQuantityPerSaleUnit: 10, newQuantityPerSaleUnit: 20 })
  })

  it('mesma UNIT + mesma quantidade -- NOOP, nao grava evento nem atualiza updatedAt', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-NOOP' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: 'KG' }])
    const first = await upsertBySku({ sku: 'SKU-NOOP', quantity: 10, actor: 'tester' })

    const second = await upsertBySku({ sku: 'SKU-NOOP', quantity: 10, actor: 'tester2' })
    expect(second).toEqual(first)

    const events = await db.select().from(schema.productSaleUnitConfigEvents).where(eq(schema.productSaleUnitConfigEvents.managedProductId, product.id))
    expect(events).toHaveLength(1) // so o CREATE original, sem UPDATE espurio
  })

  it('SKU nao encontrado na whitelist -- MeasuredPackageError, nada gravado', async () => {
    await expect(upsertBySku({ sku: 'INEXISTENTE', quantity: 1, actor: 'tester' })).rejects.toThrow(MeasuredPackageError)
    expect(mockFetchStockForProducts).not.toHaveBeenCalled()
  })

  it('produto inativo na whitelist -- MeasuredPackageError, nunca consulta o CISS', async () => {
    await insertProduct({ wakeSku: 'SKU-INATIVO', active: false })
    await expect(upsertBySku({ sku: 'SKU-INATIVO', quantity: 1, actor: 'tester' })).rejects.toThrow(MeasuredPackageError)
    expect(mockFetchStockForProducts).not.toHaveBeenCalled()
  })

  it('CISS sem registro (noRecord) -- MeasuredPackageError "nao retornou UNIT"', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-NORECORD' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 0, noRecord: true, unitRaw: null }])
    await expect(upsertBySku({ sku: 'SKU-NORECORD', quantity: 1, actor: 'tester' })).rejects.toThrow(/não retornou UNIT/)
  })

  it('UNIT diferente de KG/MT (ex: CT/PC) -- MeasuredPackageError, nunca infere', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-CT' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 3, unitRaw: 'CT' }])
    await expect(upsertBySku({ sku: 'SKU-CT', quantity: 1, actor: 'tester' })).rejects.toThrow(/CT/)
  })

  it('quantidade <= 0 -- MeasuredPackageError, nunca chega a consultar o CISS', async () => {
    await insertProduct({ wakeSku: 'SKU-QTY0' })
    await expect(upsertBySku({ sku: 'SKU-QTY0', quantity: 0, actor: 'tester' })).rejects.toThrow(MeasuredPackageError)
    await expect(upsertBySku({ sku: 'SKU-QTY0', quantity: -5, actor: 'tester' })).rejects.toThrow(MeasuredPackageError)
    expect(mockFetchStockForProducts).not.toHaveBeenCalled()
  })

  it('quantidade NaN/Infinity -- MeasuredPackageError', async () => {
    await insertProduct({ wakeSku: 'SKU-NAN' })
    await expect(upsertBySku({ sku: 'SKU-NAN', quantity: NaN, actor: 'tester' })).rejects.toThrow(MeasuredPackageError)
    await expect(upsertBySku({ sku: 'SKU-NAN', quantity: Infinity, actor: 'tester' })).rejects.toThrow(MeasuredPackageError)
  })

  it('falha de infraestrutura no CISS (rede/5xx) -- MeasuredPackageInfraError, nunca vira "UNIT invalido"', async () => {
    await insertProduct({ wakeSku: 'SKU-INFRA' })
    mockFetchStockForProducts.mockRejectedValue(new Error('ECONNRESET'))
    await expect(upsertBySku({ sku: 'SKU-INFRA', quantity: 1, actor: 'tester' })).rejects.toThrow(MeasuredPackageInfraError)
  })
})

describe('deactivateConfig / reactivateConfig -- FASE E §4 (nunca hard-delete)', () => {
  it('desativa uma config ativa e grava evento DEACTIVATE', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-DEACT' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: 'KG' }])
    const config = await upsertBySku({ sku: 'SKU-DEACT', quantity: 10, actor: 'tester' })

    await deactivateConfig(config.id, 'tester2')

    const [row] = await db.select().from(schema.productSaleUnitConfig).where(eq(schema.productSaleUnitConfig.id, config.id))
    expect(row?.active).toBe(false)
    expect(row?.updatedBy).toBe('tester2')

    const events = await db.select().from(schema.productSaleUnitConfigEvents).where(eq(schema.productSaleUnitConfigEvents.managedProductId, product.id))
    expect(events.map((e) => e.action)).toEqual(['CREATE', 'DEACTIVATE'])
  })

  it('desativar config inexistente -- MeasuredPackageError', async () => {
    await expect(deactivateConfig(999999, 'tester')).rejects.toThrow(MeasuredPackageError)
  })

  it('desativar config ja inativa -- MeasuredPackageError', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-DEACT2' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: 'KG' }])
    const config = await upsertBySku({ sku: 'SKU-DEACT2', quantity: 10, actor: 'tester' })
    await deactivateConfig(config.id, 'tester')
    await expect(deactivateConfig(config.id, 'tester')).rejects.toThrow(MeasuredPackageError)
  })

  it('reativa uma config inativa quando nao ha outra ativa pro mesmo produto', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-REACT' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: 'KG' }])
    const config = await upsertBySku({ sku: 'SKU-REACT', quantity: 10, actor: 'tester' })
    await deactivateConfig(config.id, 'tester')

    const reactivated = await reactivateConfig(config.id, 'tester3')
    expect(reactivated.active).toBe(true)
    expect(reactivated.id).toBe(config.id)

    const events = await db.select().from(schema.productSaleUnitConfigEvents).where(eq(schema.productSaleUnitConfigEvents.managedProductId, product.id))
    expect(events.map((e) => e.action)).toEqual(['CREATE', 'DEACTIVATE', 'REACTIVATE'])
  })

  it('reativar quando ja existe outra config ativa pro mesmo produto -- MeasuredPackageError (nunca duas ativas)', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-REACT2' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: 'KG' }])
    const first = await upsertBySku({ sku: 'SKU-REACT2', quantity: 10, actor: 'tester' })
    await deactivateConfig(first.id, 'tester')
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: 'MT' }])
    await upsertBySku({ sku: 'SKU-REACT2', quantity: 3, actor: 'tester' }) // nova ativa

    await expect(reactivateConfig(first.id, 'tester')).rejects.toThrow(MeasuredPackageError)
  })

  it('reativar config inexistente -- MeasuredPackageError', async () => {
    await expect(reactivateConfig(999999, 'tester')).rejects.toThrow(MeasuredPackageError)
  })

  it('reativar config ja ativa -- MeasuredPackageError', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-REACT3' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: 'KG' }])
    const config = await upsertBySku({ sku: 'SKU-REACT3', quantity: 10, actor: 'tester' })
    await expect(reactivateConfig(config.id, 'tester')).rejects.toThrow(MeasuredPackageError)
  })
})

describe('listConfigs / listPendingProducts -- FASE E §3', () => {
  it('listConfigs traz o SKU/nome via JOIN com managed_products, mais recente primeiro', async () => {
    const p1 = await insertProduct({ wakeSku: 'SKU-LIST-1', wakeProductName: 'Produto Um' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: p1.cissProductId, stock: 10, unitRaw: 'KG' }])
    await upsertBySku({ sku: 'SKU-LIST-1', quantity: 10, actor: 'tester' })

    const configs = await listConfigs()
    expect(configs).toHaveLength(1)
    expect(configs[0]).toMatchObject({ wakeSku: 'SKU-LIST-1', wakeProductName: 'Produto Um', cissProductId: p1.cissProductId })
  })

  it('listPendingProducts so retorna produtos ativos, com UNIT KG/MT no ultimo sync, sem config ativa', async () => {
    const pendingKg = await insertProduct({ wakeSku: 'SKU-PENDING-KG' })
    await db.insert(schema.syncProductState).values({ managedProductId: pendingKg.id, unitNormalized: 'KG' })

    const pendingMt = await insertProduct({ wakeSku: 'SKU-PENDING-MT' })
    await db.insert(schema.syncProductState).values({ managedProductId: pendingMt.id, unitNormalized: 'MT' })

    const configured = await insertProduct({ wakeSku: 'SKU-JA-CONFIGURADO' })
    await db.insert(schema.syncProductState).values({ managedProductId: configured.id, unitNormalized: 'KG' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: configured.cissProductId, stock: 10, unitRaw: 'KG' }])
    await upsertBySku({ sku: 'SKU-JA-CONFIGURADO', quantity: 10, actor: 'tester' })

    const notKgMt = await insertProduct({ wakeSku: 'SKU-CT-NAO-PENDENTE' })
    await db.insert(schema.syncProductState).values({ managedProductId: notKgMt.id, unitNormalized: 'CT' })

    const inactiveProduct = await insertProduct({ wakeSku: 'SKU-INATIVO-NAO-PENDENTE', active: false })
    await db.insert(schema.syncProductState).values({ managedProductId: inactiveProduct.id, unitNormalized: 'KG' })

    const pending = await listPendingProducts()
    const skus = pending.map((p) => p.wakeSku).sort()
    expect(skus).toEqual(['SKU-PENDING-KG', 'SKU-PENDING-MT'])
  })
})
