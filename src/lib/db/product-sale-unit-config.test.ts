import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { sql } from 'drizzle-orm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as schema from './schema'

// Testes de integridade de product_sale_unit_config -- banco SQLite real
// (arquivo temporario), migrado com as mesmas migrations de producao,
// `foreign_keys = ON` igual a src/lib/db/index.ts. NAO aplica nenhuma
// migration em producao -- so migra um arquivo .db temporario, descartado
// no final.
//
// FASE B.1 (PROBLEMA 5/§6): FK, unicidade de config ativa,
// quantity_per_sale_unit > 0.
// FASE B.2 (BLOQUEIO A/B, drizzle/0004_public_betty_brant.sql):
// - source_unit agora tem CHECK IN ('KG','MT') no SQL, nao so no tipo TS;
// - wake_sku foi removida da tabela (denormalizada, nunca lida pelo motor de
//   sync -- ver decisao documentada em src/lib/db/schema.ts).

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let dbPath: string

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `casa-hub-psuc-test-${process.pid}-${Date.now()}.db`)
  sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') })
})

afterAll(() => {
  sqlite.close()
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + suffix)
    } catch {
      /* melhor esforco -- arquivo temporario de teste */
    }
  }
})

beforeEach(() => {
  sqlite.exec('DELETE FROM product_sale_unit_config; DELETE FROM managed_products;')
})

async function insertManagedProduct(cissProductId: string) {
  const [row] = await db
    .insert(schema.managedProducts)
    .values({ cissProductId, wakeProductVariantId: `variant-${cissProductId}`, wakeSku: `SKU-${cissProductId}`, active: true })
    .returning()
  if (!row) throw new Error('insertManagedProduct falhou')
  return row
}

describe('product_sale_unit_config -- integridade do schema (FASE B.1 + FASE B.2)', () => {
  it('FK managed_product_id: rejeita config apontando pra produto inexistente (foreign_keys=ON, igual producao)', async () => {
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: 999999,
        sourceUnit: 'KG',
        quantityPerSaleUnit: 1,
        active: true,
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })

  it('unicidade: no maximo 1 config ATIVA por managed_product_id -- segunda ativa pro mesmo produto e rejeitada', async () => {
    const product = await insertManagedProduct('ciss-dup')
    await db.insert(schema.productSaleUnitConfig).values({
      managedProductId: product.id,
      sourceUnit: 'KG',
      quantityPerSaleUnit: 5,
      active: true,
    })

    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product.id,
        sourceUnit: 'MT',
        quantityPerSaleUnit: 2,
        active: true,
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/)
  })

  it('unicidade: duas configs INATIVAS pro mesmo produto sao permitidas (indice parcial so cobre active=1)', async () => {
    const product = await insertManagedProduct('ciss-inactive-dup')
    await db.insert(schema.productSaleUnitConfig).values({
      managedProductId: product.id,
      sourceUnit: 'KG',
      quantityPerSaleUnit: 5,
      active: false,
    })
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product.id,
        sourceUnit: 'MT',
        quantityPerSaleUnit: 2,
        active: false,
      }),
    ).resolves.not.toThrow()
  })

  it('quantity_per_sale_unit > 0: CHECK constraint rejeita zero e negativo no nivel do banco', async () => {
    const product = await insertManagedProduct('ciss-qty-zero')
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product.id,
        sourceUnit: 'KG',
        quantityPerSaleUnit: 0,
        active: true,
      }),
    ).rejects.toThrow(/CHECK constraint failed/)

    const product2 = await insertManagedProduct('ciss-qty-neg')
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product2.id,
        sourceUnit: 'KG',
        quantityPerSaleUnit: -5,
        active: true,
      }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('BLOQUEIO A (FASE B.2): source_unit agora tem CHECK no banco -- PC (ou qualquer valor fora de KG/MT) e rejeitado mesmo por fora do tipo TS', async () => {
    const product = await insertManagedProduct('ciss-bad-unit')
    // Cast deliberado: simula um valor invalido chegando por fora do tipo TS
    // (ex.: SQL bruto, migracao de dados, bug em outra camada) -- exatamente
    // o cenario que o CHECK precisa cobrir, nao um erro de digitacao a
    // esconder.
    const invalidSourceUnit = 'PC' as 'KG' | 'MT'
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product.id,
        sourceUnit: invalidSourceUnit,
        quantityPerSaleUnit: 1,
        active: true,
      }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('BLOQUEIO A (FASE B.2): source_unit=KG e aceito pelo CHECK do banco', async () => {
    const product = await insertManagedProduct('ciss-unit-kg')
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product.id,
        sourceUnit: 'KG',
        quantityPerSaleUnit: 1,
        active: true,
      }),
    ).resolves.not.toThrow()
  })

  it('BLOQUEIO A (FASE B.2): source_unit=MT e aceito pelo CHECK do banco', async () => {
    const product = await insertManagedProduct('ciss-unit-mt')
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product.id,
        sourceUnit: 'MT',
        quantityPerSaleUnit: 1,
        active: true,
      }),
    ).resolves.not.toThrow()
  })

  it('BLOQUEIO B (FASE B.2): wake_sku nao existe mais na tabela -- linha inserida so com managed_product_id/source_unit/quantity_per_sale_unit', async () => {
    const product = await insertManagedProduct('ciss-no-wake-sku-column')
    await db.insert(schema.productSaleUnitConfig).values({
      managedProductId: product.id,
      sourceUnit: 'KG',
      quantityPerSaleUnit: 3,
      active: true,
    })

    const rows = await db
      .select()
      .from(schema.productSaleUnitConfig)
      .where(sql`${schema.productSaleUnitConfig.managedProductId} = ${product.id}`)
    expect(rows[0]).not.toHaveProperty('wakeSku')
    // SKU so e resolvivel via JOIN com managed_products (identidade canonica),
    // nunca mais denormalizado nesta tabela.
    expect(rows[0]?.managedProductId).toBe(product.id)
  })
})
