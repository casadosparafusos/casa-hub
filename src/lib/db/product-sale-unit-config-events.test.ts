import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as schema from './schema'

// Testes de integridade de product_sale_unit_config_events -- banco SQLite
// real (arquivo temporario), migrado com as mesmas migrations de producao,
// `foreign_keys = ON` igual a src/lib/db/index.ts. NAO aplica nenhuma
// migration em producao -- so migra um arquivo .db temporario, descartado
// no final.
//
// Tech Lead review PR #5, achado #8: mesmo bloqueio A/B de
// product_sale_unit_config (enum/quantidade so em TS, sem CHECK no SQL) se
// aplicava a tabela de auditoria -- uma insercao direta (fora do Drizzle,
// migracao de dados, bug em outra camada) podia gravar action/origin/
// source_unit fora do enum, quantidade <= 0, ou a combinacao errada de
// old/new quantity pra cada action. drizzle/0006_events_check_constraints.sql
// adiciona os 6 CHECKs no nivel do banco (tabela nova nesta PR, nunca em
// producao -- por isso migration nova em vez de editar 0005, ja publicada em
// origin/feat/measured-packages-admin).

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
let dbPath: string

beforeAll(() => {
  dbPath = path.join(os.tmpdir(), `casa-hub-psuce-test-${process.pid}-${Date.now()}.db`)
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
  sqlite.exec('DELETE FROM product_sale_unit_config_events; DELETE FROM managed_products;')
})

async function insertManagedProduct(cissProductId: string) {
  const [row] = await db
    .insert(schema.managedProducts)
    .values({ cissProductId, wakeProductVariantId: `variant-${cissProductId}`, wakeSku: `SKU-${cissProductId}`, active: true })
    .returning()
  if (!row) throw new Error('insertManagedProduct falhou')
  return row
}

describe('product_sale_unit_config_events -- integridade do schema (Tech Lead review PR #5, achado #8)', () => {
  it('action: CHECK rejeita valor fora do enum (CREATE/UPDATE/DEACTIVATE/REACTIVATE)', async () => {
    const product = await insertManagedProduct('ciss-events-bad-action')
    const invalidAction = 'DELETE' as 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE'
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product.id,
        action: invalidAction,
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: null,
        newQuantityPerSaleUnit: 5,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('origin: CHECK rejeita valor fora do enum (MANUAL/IMPORT)', async () => {
    const product = await insertManagedProduct('ciss-events-bad-origin')
    const invalidOrigin = 'API' as 'MANUAL' | 'IMPORT'
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product.id,
        action: 'CREATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: null,
        newQuantityPerSaleUnit: 5,
        actor: 'tester',
        origin: invalidOrigin,
      }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('source_unit: CHECK rejeita valor fora do enum (KG/MT)', async () => {
    const product = await insertManagedProduct('ciss-events-bad-unit')
    const invalidSourceUnit = 'PC' as 'KG' | 'MT'
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product.id,
        action: 'CREATE',
        sourceUnit: invalidSourceUnit,
        oldQuantityPerSaleUnit: null,
        newQuantityPerSaleUnit: 5,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('old_quantity_per_sale_unit: CHECK rejeita zero e negativo (NULL continua permitido)', async () => {
    const product = await insertManagedProduct('ciss-events-old-qty-bad')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product.id,
        action: 'UPDATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: 0,
        newQuantityPerSaleUnit: 5,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)

    const product2 = await insertManagedProduct('ciss-events-old-qty-neg')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product2.id,
        action: 'UPDATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: -3,
        newQuantityPerSaleUnit: 5,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('new_quantity_per_sale_unit: CHECK rejeita zero e negativo (NULL continua permitido)', async () => {
    const product = await insertManagedProduct('ciss-events-new-qty-bad')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product.id,
        action: 'UPDATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: 5,
        newQuantityPerSaleUnit: 0,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)

    const product2 = await insertManagedProduct('ciss-events-new-qty-neg')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product2.id,
        action: 'UPDATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: 5,
        newQuantityPerSaleUnit: -1,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('shape CREATE/REACTIVATE: CHECK exige old=NULL e new preenchido -- rejeita old preenchido ou new=NULL', async () => {
    const product = await insertManagedProduct('ciss-events-create-old-filled')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product.id,
        action: 'CREATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: 5,
        newQuantityPerSaleUnit: 8,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)

    const product2 = await insertManagedProduct('ciss-events-reactivate-new-null')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product2.id,
        action: 'REACTIVATE',
        sourceUnit: 'MT',
        oldQuantityPerSaleUnit: null,
        newQuantityPerSaleUnit: null,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('shape DEACTIVATE: CHECK exige old preenchido e new=NULL -- rejeita old=NULL ou new preenchido', async () => {
    const product = await insertManagedProduct('ciss-events-deactivate-old-null')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product.id,
        action: 'DEACTIVATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: null,
        newQuantityPerSaleUnit: null,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)

    const product2 = await insertManagedProduct('ciss-events-deactivate-new-filled')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product2.id,
        action: 'DEACTIVATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: 5,
        newQuantityPerSaleUnit: 5,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('shape UPDATE: CHECK exige old e new preenchidos -- rejeita qualquer um NULL', async () => {
    const product = await insertManagedProduct('ciss-events-update-old-null')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product.id,
        action: 'UPDATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: null,
        newQuantityPerSaleUnit: 8,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)

    const product2 = await insertManagedProduct('ciss-events-update-new-null')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: product2.id,
        action: 'UPDATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: 8,
        newQuantityPerSaleUnit: null,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('linhas validas (CREATE, UPDATE, DEACTIVATE, REACTIVATE) sao aceitas pelos CHECKs', async () => {
    const create = await insertManagedProduct('ciss-events-ok-create')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: create.id,
        action: 'CREATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: null,
        newQuantityPerSaleUnit: 10,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).resolves.not.toThrow()

    const update = await insertManagedProduct('ciss-events-ok-update')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: update.id,
        action: 'UPDATE',
        sourceUnit: 'MT',
        oldQuantityPerSaleUnit: 10,
        newQuantityPerSaleUnit: 20,
        actor: 'tester',
        origin: 'IMPORT',
        filename: 'planilha.xlsx',
      }),
    ).resolves.not.toThrow()

    const deactivate = await insertManagedProduct('ciss-events-ok-deactivate')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: deactivate.id,
        action: 'DEACTIVATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: 10,
        newQuantityPerSaleUnit: null,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).resolves.not.toThrow()

    const reactivate = await insertManagedProduct('ciss-events-ok-reactivate')
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: reactivate.id,
        action: 'REACTIVATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: null,
        newQuantityPerSaleUnit: 15,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).resolves.not.toThrow()
  })

  it('FK managed_product_id: rejeita evento apontando pra produto inexistente (foreign_keys=ON, igual producao)', async () => {
    await expect(
      db.insert(schema.productSaleUnitConfigEvents).values({
        managedProductId: 999999,
        action: 'CREATE',
        sourceUnit: 'KG',
        oldQuantityPerSaleUnit: null,
        newQuantityPerSaleUnit: 5,
        actor: 'tester',
        origin: 'MANUAL',
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/)
  })
})
