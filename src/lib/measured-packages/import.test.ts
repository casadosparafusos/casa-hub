import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RawImportRow } from './types'

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
let validateImportRows: typeof import('./import').validateImportRows
let applyImport: typeof import('./import').applyImport
let MeasuredPackageInfraError: typeof import('./types').MeasuredPackageInfraError
let dbPath: string

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `casa-hub-measured-packages-import-test-${process.pid}-${Date.now()}.db`)
  process.env.DATABASE_PATH = dbPath

  const migrateSqlite = new Database(dbPath)
  migrateSqlite.pragma('journal_mode = WAL')
  migrate(drizzle(migrateSqlite), { migrationsFolder: path.join(process.cwd(), 'drizzle') })
  migrateSqlite.close()

  ;({ db, schema } = await import('../db'))
  ;({ validateImportRows, applyImport } = await import('./import'))
  ;({ MeasuredPackageInfraError } = await import('./types'))
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
      wakeProductVariantId: String(3000 + n),
      wakeSku: `SKU-${n}`,
      active: true,
      ...overrides,
    })
    .returning()
  if (!row) throw new Error('insertProduct falhou')
  return row
}

function row(overrides: Partial<RawImportRow>): RawImportRow {
  return { line: 2, sheet: 'CSV', sku: 'SKU-X', nameFromFile: 'Produto X', sourceUnit: 'KG', quantity: 10, parseError: null, ...overrides }
}

describe('validateImportRows -- ordem de validacao do FASE E §10', () => {
  it('linha com erro de parse vira ERROR sem consultar whitelist/CISS pra essa linha', async () => {
    const result = await validateImportRows([row({ sku: '', parseError: 'SKU vazio.' })])
    expect(result.rows[0]).toMatchObject({ action: 'ERROR', status: 'error', message: 'SKU vazio.' })
    expect(result.errorCount).toBe(1)
  })

  it('SKU duplicado no arquivo -- todas as ocorrencias viram ERROR, nunca consulta a whitelist pra esse SKU', async () => {
    await insertProduct({ wakeSku: 'SKU-DUP' })
    const result = await validateImportRows([row({ sku: 'SKU-DUP', line: 2 }), row({ sku: 'SKU-DUP', line: 3 })])
    expect(result.rows.every((r) => r.action === 'ERROR' && r.message?.includes('duplicado'))).toBe(true)
    expect(mockFetchStockForProducts).not.toHaveBeenCalled()
  })

  it('SKU nao encontrado na whitelist -- ERROR', async () => {
    const result = await validateImportRows([row({ sku: 'NAO-EXISTE' })])
    expect(result.rows[0]).toMatchObject({ action: 'ERROR', managedProductId: null })
    expect(result.rows[0]?.message).toMatch(/não encontrado na whitelist/)
  })

  it('produto inativo -- ERROR, nao consulta CISS pra esse SKU (nenhum id ativo pra consultar)', async () => {
    await insertProduct({ wakeSku: 'SKU-INATIVO', active: false })
    const result = await validateImportRows([row({ sku: 'SKU-INATIVO' })])
    expect(result.rows[0]).toMatchObject({ action: 'ERROR' })
    expect(result.rows[0]?.message).toMatch(/inativo/)
    expect(mockFetchStockForProducts).not.toHaveBeenCalled()
  })

  it('CISS sem UNIT (noRecord) -- ERROR', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-NORECORD' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 0, noRecord: true, unitRaw: null }])
    const result = await validateImportRows([row({ sku: 'SKU-NORECORD' })])
    expect(result.rows[0]).toMatchObject({ action: 'ERROR' })
    expect(result.rows[0]?.message).toMatch(/não retornou UNIT/)
  })

  it('header QT KG mas CISS diz MT -- ERROR, nunca aceita silenciosamente', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-MISMATCH' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: 'MT' }])
    const result = await validateImportRows([row({ sku: 'SKU-MISMATCH', sourceUnit: 'KG' })])
    expect(result.rows[0]).toMatchObject({ action: 'ERROR', detectedUnit: 'MT' })
    expect(result.rows[0]?.message).toMatch(/MT no CISS/)
  })

  it('UNIT do CISS e algo fora de KG/MT (ex: CT) -- ERROR, nunca infere por nome', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-CT' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: 'CT' }])
    const result = await validateImportRows([row({ sku: 'SKU-CT', sourceUnit: 'KG' })])
    expect(result.rows[0]?.action).toBe('ERROR')
  })

  it('quantidade nula ou <= 0 -- ERROR mesmo com UNIT correto', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-QTY' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 10, unitRaw: 'KG' }])
    const result = await validateImportRows([row({ sku: 'SKU-QTY', quantity: 0 }), row({ sku: 'SKU-QTY', quantity: null, line: 3 })])
    expect(result.rows.every((r) => r.action === 'ERROR')).toBe(true)
  })

  it('sem config existente + tudo valido -- CREATE', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-CREATE' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 180, unitRaw: 'KG' }])
    const result = await validateImportRows([row({ sku: 'SKU-CREATE', quantity: 18 })])
    expect(result.rows[0]).toMatchObject({ action: 'CREATE', status: 'valid', quantityPerSaleUnit: 18 })
    expect(result.createCount).toBe(1)
  })

  it('config existente com UNIT/quantidade diferente -- UPDATE', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-UPDATE' })
    await db.insert(schema.productSaleUnitConfig).values({ managedProductId: product.id, sourceUnit: 'KG', quantityPerSaleUnit: 10, active: true })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 180, unitRaw: 'KG' }])
    const result = await validateImportRows([row({ sku: 'SKU-UPDATE', quantity: 18 })])
    expect(result.rows[0]?.action).toBe('UPDATE')
    expect(result.updateCount).toBe(1)
  })

  it('config existente com mesma UNIT e mesma quantidade -- NOOP', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-NOOP' })
    await db.insert(schema.productSaleUnitConfig).values({ managedProductId: product.id, sourceUnit: 'KG', quantityPerSaleUnit: 18, active: true })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 180, unitRaw: 'KG' }])
    const result = await validateImportRows([row({ sku: 'SKU-NOOP', quantity: 18 })])
    expect(result.rows[0]?.action).toBe('NOOP')
    expect(result.noopCount).toBe(1)
  })

  it('sem config ativa mas com uma inativa -- ERROR, nunca cria uma segunda config ativa por cima (Tech Lead review PR #5, achado #5)', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-INACTIVE-CONFIG' })
    await db.insert(schema.productSaleUnitConfig).values({ managedProductId: product.id, sourceUnit: 'KG', quantityPerSaleUnit: 10, active: false })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 180, unitRaw: 'KG' }])
    const result = await validateImportRows([row({ sku: 'SKU-INACTIVE-CONFIG', quantity: 18 })])
    expect(result.rows[0]).toMatchObject({ action: 'ERROR' })
    expect(result.rows[0]?.message).toMatch(/inativa/)
    expect(result.errorCount).toBe(1)
  })

  // Tech Lead review PR #5, achado #6: identidade da linha (sheet) precisa
  // sobreviver ate o ValidatedImportRow -- sem isso, duas abas XLSX com o
  // mesmo numero de linha ficam indistinguiveis no preview/relatorio.
  it('sheet e propagado de RawImportRow pra ValidatedImportRow, inclusive em linhas de abas diferentes com o mesmo numero de linha', async () => {
    const kgProduct = await insertProduct({ wakeSku: 'SKU-SHEET-KG' })
    const mtProduct = await insertProduct({ wakeSku: 'SKU-SHEET-MT' })
    mockFetchStockForProducts.mockResolvedValue([
      { productId: kgProduct.cissProductId, stock: 180, unitRaw: 'KG' },
      { productId: mtProduct.cissProductId, stock: 180, unitRaw: 'MT' },
    ])

    const result = await validateImportRows([
      row({ sku: 'SKU-SHEET-KG', sheet: 'KG', line: 2, sourceUnit: 'KG', quantity: 18 }),
      row({ sku: 'SKU-SHEET-MT', sheet: 'MT', line: 2, sourceUnit: 'MT', quantity: 5 }),
    ])

    expect(result.rows[0]).toMatchObject({ sheet: 'KG', line: 2, sku: 'SKU-SHEET-KG' })
    expect(result.rows[1]).toMatchObject({ sheet: 'MT', line: 2, sku: 'SKU-SHEET-MT' })
  })

  it('falha de infraestrutura no CISS -- aborta a validacao inteira (MeasuredPackageInfraError), nunca vira erro por linha', async () => {
    await insertProduct({ wakeSku: 'SKU-INFRA' })
    mockFetchStockForProducts.mockRejectedValue(new Error('timeout'))
    await expect(validateImportRows([row({ sku: 'SKU-INFRA' })])).rejects.toThrow(MeasuredPackageInfraError)
  })
})

describe('applyImport -- FASE E §11 (revalida do zero, nunca confia no preview)', () => {
  it('aplica CREATE e UPDATE, ignora NOOP, tudo dentro de uma transacao', async () => {
    const createProduct = await insertProduct({ wakeSku: 'SKU-APPLY-CREATE' })
    const updateProduct = await insertProduct({ wakeSku: 'SKU-APPLY-UPDATE' })
    await db.insert(schema.productSaleUnitConfig).values({ managedProductId: updateProduct.id, sourceUnit: 'KG', quantityPerSaleUnit: 5, active: true })
    const noopProduct = await insertProduct({ wakeSku: 'SKU-APPLY-NOOP' })
    await db.insert(schema.productSaleUnitConfig).values({ managedProductId: noopProduct.id, sourceUnit: 'KG', quantityPerSaleUnit: 7, active: true })

    mockFetchStockForProducts.mockResolvedValue([
      { productId: createProduct.cissProductId, stock: 180, unitRaw: 'KG' },
      { productId: updateProduct.cissProductId, stock: 180, unitRaw: 'KG' },
      { productId: noopProduct.cissProductId, stock: 180, unitRaw: 'KG' },
    ])

    const result = await applyImport(
      [row({ sku: 'SKU-APPLY-CREATE', quantity: 18, line: 2 }), row({ sku: 'SKU-APPLY-UPDATE', quantity: 20, line: 3 }), row({ sku: 'SKU-APPLY-NOOP', quantity: 7, line: 4 })],
      { actor: 'tester', filename: 'planilha.csv' },
    )

    expect(result.status).toBe('success')
    expect(result.appliedCount).toBe(2)

    const [createdConfig] = await db.select().from(schema.productSaleUnitConfig).where(eq(schema.productSaleUnitConfig.managedProductId, createProduct.id))
    expect(createdConfig).toMatchObject({ sourceUnit: 'KG', quantityPerSaleUnit: 18, updatedBy: 'tester' })

    const [updatedConfig] = await db.select().from(schema.productSaleUnitConfig).where(eq(schema.productSaleUnitConfig.managedProductId, updateProduct.id))
    expect(updatedConfig).toMatchObject({ quantityPerSaleUnit: 20 })

    const events = await db.select().from(schema.productSaleUnitConfigEvents)
    expect(events.every((e) => e.origin === 'IMPORT' && e.filename === 'planilha.csv')).toBe(true)
    expect(events.map((e) => e.action).sort()).toEqual(['CREATE', 'UPDATE'])
  })

  it('nenhuma linha gravavel (so ERROR/NOOP) -- appliedCount=0, status=failed quando ha erro', async () => {
    const result = await applyImport([row({ sku: 'SKU-NAO-EXISTE' })], { actor: 'tester', filename: 'planilha.csv' })
    expect(result.appliedCount).toBe(0)
    expect(result.status).toBe('failed')

    const configs = await db.select().from(schema.productSaleUnitConfig)
    expect(configs).toHaveLength(0)
  })

  it('mistura de linhas validas e invalidas -- status partial, so as validas sao gravadas', async () => {
    const okProduct = await insertProduct({ wakeSku: 'SKU-PARTIAL-OK' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: okProduct.cissProductId, stock: 180, unitRaw: 'KG' }])

    const result = await applyImport([row({ sku: 'SKU-PARTIAL-OK', quantity: 18, line: 2 }), row({ sku: 'SKU-NAO-EXISTE', line: 3 })], {
      actor: 'tester',
      filename: 'planilha.csv',
    })

    expect(result.status).toBe('partial')
    expect(result.appliedCount).toBe(1)
    expect(result.errorCount).toBe(1)
  })

  it('revalida do zero no apply -- se o CISS mudou UNIT entre preview e apply, a linha vira ERROR (nunca confia no JSON do preview)', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-REVALIDATE' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 180, unitRaw: 'KG' }])
    const preview = await validateImportRows([row({ sku: 'SKU-REVALIDATE', quantity: 18 })])
    expect(preview.rows[0]?.action).toBe('CREATE')

    // Entre o preview e o apply, o CISS passou a responder MT pro mesmo produto.
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 180, unitRaw: 'MT' }])
    const applied = await applyImport([row({ sku: 'SKU-REVALIDATE', quantity: 18, sourceUnit: 'KG' })], { actor: 'tester', filename: 'planilha.csv' })

    expect(applied.appliedCount).toBe(0)
    expect(applied.rows[0]?.action).toBe('ERROR')
    const configs = await db.select().from(schema.productSaleUnitConfig).where(eq(schema.productSaleUnitConfig.managedProductId, product.id))
    expect(configs).toHaveLength(0)
  })

  it('falha de infraestrutura no CISS durante o apply -- aborta antes de escrever qualquer coisa', async () => {
    await insertProduct({ wakeSku: 'SKU-APPLY-INFRA' })
    mockFetchStockForProducts.mockRejectedValue(new Error('ECONNRESET'))
    await expect(applyImport([row({ sku: 'SKU-APPLY-INFRA' })], { actor: 'tester', filename: 'planilha.csv' })).rejects.toThrow(MeasuredPackageInfraError)
    const configs = await db.select().from(schema.productSaleUnitConfig)
    expect(configs).toHaveLength(0)
  })
})
