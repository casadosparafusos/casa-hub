import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('server-only', () => ({}))

// FASE D-PRE §4 (achado independente do Tech Lead): antes deste arquivo,
// zero teste cobria o comportamento fail-open de getNumberRule()/
// getStockSourceValue() -- um valor persistido invalido (NaN, negativo, fora
// de faixa) caia SILENCIOSAMENTE no default, exatamente como se o setting
// nunca tivesse sido configurado. Este arquivo prova as 4 categorias
// exigidas pela auditoria: valor AUSENTE ainda usa o default (comportamento
// antigo, preservado); valor PRESENTE-E-INVALIDO agora lanca
// SettingValidationError (nunca mais um fallback silencioso); valor VALIDO
// nao muda de comportamento.
//
// Banco SQLite real (arquivo temporario), migrado com as mesmas migrations
// de producao -- mesmo padrao de src/lib/sync/engine.test.ts e
// src/lib/db/product-sale-unit-config.test.ts.

let db: typeof import('./db').db
let schema: typeof import('./db').schema
let settings: typeof import('./settings')
let dbPath: string

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `casa-hub-settings-test-${process.pid}-${Date.now()}.db`)
  process.env.DATABASE_PATH = dbPath

  const migrateSqlite = new Database(dbPath)
  migrateSqlite.pragma('journal_mode = WAL')
  migrate(drizzle(migrateSqlite), { migrationsFolder: path.join(process.cwd(), 'drizzle') })
  migrateSqlite.close()

  ;({ db, schema } = await import('./db'))
  settings = await import('./settings')
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

const NUMBER_RULE_ENV_KEYS = [
  'UNIT_PRICE_MARKUP_PERCENT',
  'WHOLESALE_DISCOUNT_PERCENT',
  'WHOLESALE_MIN_QTY',
  'STOCK_PERCENT',
  'RECONCILIATION_HOUR_LOCAL',
  'STOCK_SYNC_INTERVAL_MINUTES',
  'PRICE_SYNC_INTERVAL_HOURS',
  'CISS_STOCK_ENTERPRISE',
  'CISS_STOCK_LOCATION',
  'WAKE_CD_ID',
  'WAKE_PRICE_TABLE_ID',
  'WAKE_PROMOTION_ID',
]

beforeEach(async () => {
  await db.delete(schema.settings)
  // getSetting() prioriza env var sobre banco (ver settings.ts#envOverride)
  // -- sem isso, uma env var deixada por OUTRO arquivo de teste (ex:
  // engine.test.ts seta WAKE_CD_ID/WAKE_PRICE_TABLE_ID/WAKE_PROMOTION_ID)
  // mascararia o valor persistido no banco que estes testes escrevem.
  for (const key of NUMBER_RULE_ENV_KEYS) delete process.env[key]
})

afterEach(async () => {
  for (const key of NUMBER_RULE_ENV_KEYS) delete process.env[key]
})

describe('validateSettingValue -- faixas exatas da FASE D-PRE §4', () => {
  it.each([
    ['UNIT_PRICE_MARKUP_PERCENT', '0', 0],
    ['UNIT_PRICE_MARKUP_PERCENT', '35.5', 35.5],
    ['WHOLESALE_DISCOUNT_PERCENT', '0', 0],
    ['WHOLESALE_DISCOUNT_PERCENT', '100', 100],
    ['STOCK_PERCENT', '10', 10],
    ['STOCK_PERCENT', '100', 100],
    ['WHOLESALE_MIN_QTY', '1', 1],
    ['WHOLESALE_MIN_QTY', '100', 100],
    ['RECONCILIATION_HOUR_LOCAL', '0', 0],
    ['RECONCILIATION_HOUR_LOCAL', '23', 23],
    ['STOCK_SYNC_INTERVAL_MINUTES', '0.5', 0.5],
    ['PRICE_SYNC_INTERVAL_HOURS', '24', 24],
    ['CISS_STOCK_ENTERPRISE', '2', 2],
    ['CISS_STOCK_LOCATION', '5', 5],
    ['WAKE_CD_ID', '25', 25],
    ['WAKE_PRICE_TABLE_ID', '74', 74],
    ['WAKE_PROMOTION_ID', '10365', 10365],
  ])('%s: %s dentro da faixa -> %d', (key, raw, expected) => {
    expect(settings.validateSettingValue(key, raw)).toBe(expected)
  })

  it.each([
    ['UNIT_PRICE_MARKUP_PERCENT', '-0.01'], // < 0
    ['UNIT_PRICE_MARKUP_PERCENT', 'abc'],
    ['WHOLESALE_DISCOUNT_PERCENT', '-1'], // < 0
    ['WHOLESALE_DISCOUNT_PERCENT', '100.01'], // > 100
    ['STOCK_PERCENT', '101'], // > 100
    ['WHOLESALE_MIN_QTY', '0'], // precisa ser > 0
    ['WHOLESALE_MIN_QTY', '-5'],
    ['WHOLESALE_MIN_QTY', '2.5'], // precisa ser inteiro
    ['RECONCILIATION_HOUR_LOCAL', '24'], // > 23
    ['RECONCILIATION_HOUR_LOCAL', '-1'],
    ['STOCK_SYNC_INTERVAL_MINUTES', '0'], // precisa ser > 0
    ['PRICE_SYNC_INTERVAL_HOURS', '-1'],
    ['CISS_STOCK_ENTERPRISE', '0'], // precisa ser > 0
    ['CISS_STOCK_ENTERPRISE', '2.5'], // precisa ser inteiro
    ['CISS_STOCK_LOCATION', '-5'],
    ['WAKE_CD_ID', '0'],
    ['WAKE_CD_ID', 'abc'],
    ['WAKE_PRICE_TABLE_ID', '-74'],
    ['WAKE_PROMOTION_ID', 'NaN'],
  ])('%s: %s fora da faixa -> lanca SettingValidationError', (key, raw) => {
    expect(() => settings.validateSettingValue(key, raw)).toThrow(settings.SettingValidationError)
  })
})

describe('getCommercialPolicyConfig/rules/stockSource -- as 4 categorias exigidas (FASE D-PRE §4)', () => {
  it('AUSENTE: nenhum setting persistido -- usa RULE_DEFAULTS/STOCK_SOURCE_DEFAULTS (comportamento antigo preservado)', async () => {
    const config = await settings.getCommercialPolicyConfig()
    expect(config).toEqual({
      markupPercent: settings.RULE_DEFAULTS.UNIT_PRICE_MARKUP_PERCENT,
      wholesaleDiscountPercent: settings.RULE_DEFAULTS.WHOLESALE_DISCOUNT_PERCENT,
      stockExposurePercent: settings.RULE_DEFAULTS.STOCK_PERCENT,
      wholesaleMinQty: settings.RULE_DEFAULTS.WHOLESALE_MIN_QTY,
    })
    await expect(settings.stockSource.enterprise()).resolves.toBe(settings.STOCK_SOURCE_DEFAULTS.CISS_STOCK_ENTERPRISE)
    await expect(settings.stockSource.location()).resolves.toBe(settings.STOCK_SOURCE_DEFAULTS.CISS_STOCK_LOCATION)
  })

  it('VALIDO: setting persistido dentro da faixa -- comportamento inalterado (valor gravado e o valor lido)', async () => {
    await settings.setSetting('STOCK_PERCENT', '15')
    await expect(settings.rules.stockPercent()).resolves.toBe(15)

    // O resto continua no default -- prova que a mudanca e por-chave, nao global.
    const config = await settings.getCommercialPolicyConfig()
    expect(config.stockExposurePercent).toBe(15)
    expect(config.markupPercent).toBe(settings.RULE_DEFAULTS.UNIT_PRICE_MARKUP_PERCENT)
  })

  it('PRESENTE-E-INVALIDO (rule): setting persistido fora de faixa -- lanca em vez de cair no default (bug fail-open eliminado)', async () => {
    await settings.setSetting('STOCK_PERCENT', '150') // > 100, fora da faixa 0..100
    await expect(settings.rules.stockPercent()).rejects.toThrow(settings.SettingValidationError)
    // getCommercialPolicyConfig usa Promise.all -- um getter invalido derruba o config inteiro
    // (nunca um objeto parcialmente calculado com um campo default e outro invalido).
    await expect(settings.getCommercialPolicyConfig()).rejects.toThrow(settings.SettingValidationError)
  })

  it('PRESENTE-E-INVALIDO (stock source): CISS_STOCK_LOCATION="0" -- lanca em vez de cair no default 5', async () => {
    await settings.setSetting('CISS_STOCK_LOCATION', '0')
    await expect(settings.stockSource.location()).rejects.toThrow(settings.SettingValidationError)
    // CISS_STOCK_ENTERPRISE nao foi tocado -- continua usando o default normalmente.
    await expect(settings.stockSource.enterprise()).resolves.toBe(settings.STOCK_SOURCE_DEFAULTS.CISS_STOCK_ENTERPRISE)
  })

  it('PRESENTE-E-INVALIDO (texto nao numerico): WHOLESALE_MIN_QTY="cem" -- lanca em vez de virar NaN/default', async () => {
    await settings.setSetting('WHOLESALE_MIN_QTY', 'cem')
    await expect(settings.rules.wholesaleMinQty()).rejects.toThrow(settings.SettingValidationError)
  })
})

describe('checkRequiredUnconfirmed -- WAKE_CD_ID/WAKE_PRICE_TABLE_ID/WAKE_PROMOTION_ID invalidos bloqueiam igual a ausentes (FASE D-PRE §4)', () => {
  it('AUSENTE: os 5 REQUIRED_UNCONFIRMED_KEYS sem valor -- todos em `missing`', async () => {
    const { missing, values } = await settings.checkRequiredUnconfirmed()
    expect(missing.sort()).toEqual([...settings.REQUIRED_UNCONFIRMED_KEYS].sort())
    for (const key of settings.REQUIRED_UNCONFIRMED_KEYS) expect(values[key]).toBeNull()
  })

  it('VALIDO: os 5 confirmados com valores validos -- `missing` fica vazio', async () => {
    await settings.setSetting('WAKE_CD_ID', '25')
    await settings.setSetting('WAKE_STOCK_CONTROL_MODE', 'fstore')
    await settings.setSetting('WAKE_PRICE_TABLE_ID', '74')
    await settings.setSetting('WAKE_PROMOTION_ID', '10365')
    await settings.setSetting('CSV_IDENTIFIER_TYPE', 'sku')

    const { missing, values } = await settings.checkRequiredUnconfirmed()
    expect(missing).toEqual([])
    expect(values.WAKE_CD_ID).toBe('25')
  })

  it('PRESENTE-E-INVALIDO: WAKE_CD_ID="abc" -- bloqueia a sync real igual a ausente, mesmo com os outros 4 validos', async () => {
    await settings.setSetting('WAKE_CD_ID', 'abc')
    await settings.setSetting('WAKE_STOCK_CONTROL_MODE', 'fstore')
    await settings.setSetting('WAKE_PRICE_TABLE_ID', '74')
    await settings.setSetting('WAKE_PROMOTION_ID', '10365')
    await settings.setSetting('CSV_IDENTIFIER_TYPE', 'sku')

    const { missing, values } = await settings.checkRequiredUnconfirmed()
    expect(missing).toEqual(['WAKE_CD_ID'])
    // O valor bruto continua exposto (consumidores como engine.ts decidem o
    // que fazer com ele) -- so `missing` sinaliza o bloqueio.
    expect(values.WAKE_CD_ID).toBe('abc')
  })

  it('PRESENTE-E-INVALIDO: WAKE_PRICE_TABLE_ID="-74" (negativo) tambem bloqueia', async () => {
    await settings.setSetting('WAKE_CD_ID', '25')
    await settings.setSetting('WAKE_STOCK_CONTROL_MODE', 'fstore')
    await settings.setSetting('WAKE_PRICE_TABLE_ID', '-74')
    await settings.setSetting('WAKE_PROMOTION_ID', '10365')
    await settings.setSetting('CSV_IDENTIFIER_TYPE', 'sku')

    const { missing } = await settings.checkRequiredUnconfirmed()
    expect(missing).toEqual(['WAKE_PRICE_TABLE_ID'])
  })

  it('WAKE_STOCK_CONTROL_MODE/CSV_IDENTIFIER_TYPE nao tem faixa numerica -- qualquer string nao-vazia passa (fora de escopo do §4)', async () => {
    await settings.setSetting('WAKE_CD_ID', '25')
    await settings.setSetting('WAKE_STOCK_CONTROL_MODE', 'qualquer-coisa')
    await settings.setSetting('WAKE_PRICE_TABLE_ID', '74')
    await settings.setSetting('WAKE_PROMOTION_ID', '10365')
    await settings.setSetting('CSV_IDENTIFIER_TYPE', 'qualquer-coisa')

    const { missing } = await settings.checkRequiredUnconfirmed()
    expect(missing).toEqual([])
  })
})
