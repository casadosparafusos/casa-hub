import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { sql } from 'drizzle-orm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as schema from './schema'

// Testes de integridade de product_sale_unit_config (FASE B.1, PROBLEMA
// 5/§6) -- banco SQLite real (arquivo temporario), migrado com as mesmas
// migrations de producao, `foreign_keys = ON` igual a src/lib/db/index.ts.
// Responde as 5 perguntas de auditoria do doc: FK, unicidade de config
// ativa, restricao de source_unit, quantity_per_sale_unit > 0, e divergencia
// de wake_sku denormalizado. NAO aplica nenhuma migration em producao --
// so migra um arquivo .db temporario, descartado no final.

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

describe('product_sale_unit_config -- integridade do schema (FASE B.1, PROBLEMA 5)', () => {
  it('FK managed_product_id: rejeita config apontando pra produto inexistente (foreign_keys=ON, igual producao)', async () => {
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: 999999,
        wakeSku: 'SKU-INEXISTENTE',
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
      wakeSku: product.wakeSku,
      sourceUnit: 'KG',
      quantityPerSaleUnit: 5,
      active: true,
    })

    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product.id,
        wakeSku: product.wakeSku,
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
      wakeSku: product.wakeSku,
      sourceUnit: 'KG',
      quantityPerSaleUnit: 5,
      active: false,
    })
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product.id,
        wakeSku: product.wakeSku,
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
        wakeSku: product.wakeSku,
        sourceUnit: 'KG',
        quantityPerSaleUnit: 0,
        active: true,
      }),
    ).rejects.toThrow(/CHECK constraint failed/)

    const product2 = await insertManagedProduct('ciss-qty-neg')
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product2.id,
        wakeSku: product2.wakeSku,
        sourceUnit: 'KG',
        quantityPerSaleUnit: -5,
        active: true,
      }),
    ).rejects.toThrow(/CHECK constraint failed/)
  })

  it('ISSUE FOUND (nao corrigido nesta fase): source_unit NAO tem CHECK/enum no banco -- so no tipo TS -- valor fora de KG/MT e aceito', async () => {
    // resolveUnit()/PACKAGE_UNITS (src/lib/units/resolver.ts) so reconhece
    // KG/MT -- um valor invalido aqui nunca seria escrito no Wake (o motor
    // puro falha closed antes disso), mas a INTEGRIDADE DO DADO em si nao e
    // protegida pelo schema: drizzle's `text(..., {enum:[...]})` e so
    // tipagem TypeScript, nao gera CREATE TABLE ... CHECK (ver
    // drizzle/0003_unit_strategies_schema.sql, coluna source_unit e so
    // `text NOT NULL`). Registrado aqui como gap conhecido pro relatorio
    // final da FASE B.1 (PROBLEMA 5) -- fechar exigiria nova migration
    // (fora do escopo desta fase, que proibe aplicar migration em producao).
    const product = await insertManagedProduct('ciss-bad-unit')
    // Cast deliberado: simula um valor invalido chegando por fora do tipo TS
    // (ex.: SQL bruto, migracao de dados, bug em outra camada) -- e
    // exatamente o gap sob teste, nao um erro de digitacao a esconder.
    const invalidSourceUnit = 'CT' as 'KG' | 'MT'
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product.id,
        wakeSku: product.wakeSku,
        sourceUnit: invalidSourceUnit,
        quantityPerSaleUnit: 1,
        active: true,
      }),
    ).resolves.not.toThrow()
  })

  it('wake_sku denormalizado: schema nao impede divergencia do managed_products.wake_sku (motor de sync nunca le esse campo, so managedProductId -- ver src/lib/sync/engine.ts)', async () => {
    const product = await insertManagedProduct('ciss-sku-drift')
    // Grava um wake_sku deliberadamente DIFERENTE do managed_products.wake_sku
    // real (product.wakeSku = 'SKU-ciss-sku-drift') -- nada no schema impede.
    await expect(
      db.insert(schema.productSaleUnitConfig).values({
        managedProductId: product.id,
        wakeSku: 'SKU-COMPLETAMENTE-DIFERENTE',
        sourceUnit: 'KG',
        quantityPerSaleUnit: 1,
        active: true,
      }),
    ).resolves.not.toThrow()

    const rows = await db
      .select()
      .from(schema.productSaleUnitConfig)
      .where(sql`${schema.productSaleUnitConfig.managedProductId} = ${product.id}`)
    expect(rows[0]?.wakeSku).toBe('SKU-COMPLETAMENTE-DIFERENTE')
    expect(rows[0]?.wakeSku).not.toBe(product.wakeSku)
    // Sem impacto funcional hoje: src/lib/sync/engine.ts busca packageConfig
    // por packageConfigs.get(product.id) (o FK), nunca por wake_sku desta
    // tabela -- confirmado por leitura de codigo (grep em engine.ts).
  })
})
