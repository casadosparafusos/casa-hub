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

// FASE C §3: 'live' por default -- os testes de escrita real (dryRun:false)
// ja existentes nao podem ser bloqueados pelo novo guard
// MOCK_PROVIDER_WRITE_BLOCKED. Sobrescrito so pelos testes que exercitam o
// guard em si (ver describe dedicado abaixo).
let activePriceProviderName: 'mock' | 'live' = 'live'
vi.mock('../ciss/price-provider', () => ({
  getActivePriceProvider: () => ({ name: activePriceProviderName, getRetailPrices: mockGetRetailPrices }),
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
// FASE C.1 §2/§3: sem este mock, qualquer teste dryRun:false que chegue no
// ramo ACK-aceito do estoque cairia no `...actual` e dispararia uma chamada
// de rede de verdade (readWakeStockByVariantId real) -- ver descoberta do
// gap de mock antes de escrever os testes de estoque desta rodada.
const mockReadWakeStockByVariantId = vi.fn<(variantId: number, cdId: number) => Promise<number | null>>()
// Revisao Tech Lead PR #4, fix #4: sem este mock, readWakePriceTableByVariantId
// (nova funcao, substitui o segundo full-scan) cai no `...actual` abaixo e
// dispara uma chamada de rede de verdade -- exatamente o gap de mock que ja
// tinha side mordido readWakeStockByVariantId antes (ver comentario acima).
const mockReadWakePriceTableByVariantId = vi.fn<(variantId: number, tableId: number) => Promise<{ precoDe: number; precoPor: number } | null>>()

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
    readWakeStockByVariantId: (...args: Parameters<typeof mockReadWakeStockByVariantId>) => mockReadWakeStockByVariantId(...args),
    readWakePriceTableByVariantId: (...args: Parameters<typeof mockReadWakePriceTableByVariantId>) => mockReadWakePriceTableByVariantId(...args),
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
  activePriceProviderName = 'live'
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
  mockReadWakeStockByVariantId.mockReset().mockResolvedValue(null)
  mockReadWakePriceTableByVariantId.mockReset().mockResolvedValue(null)
  unitPriceOverride = null

  // Os 4 REQUIRED_UNCONFIRMED_KEYS (ver src/lib/settings.ts) -- so
  // necessarios pra dryRun:false passar por checkRequiredUnconfirmed() sem
  // recusar a run; nao afetam os testes dry-run existentes (que ignoram
  // "missing"). CSV_IDENTIFIER_TYPE removida desta lista na revisao Tech
  // Lead do PR #4 (fix #3) -- nao tem consumidor real, ver settings.ts.
  process.env.WAKE_STOCK_CONTROL_MODE = 'fstore'
  process.env.WAKE_PRICE_TABLE_ID = '74'
  process.env.WAKE_PROMOTION_ID = '10365'
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
    mockReadWakeStockByVariantId.mockResolvedValue(7) // FASE C.1: releitura precisa confirmar o valor enviado pra virar 'applied'

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
    mockReadWakeStockByVariantId.mockResolvedValue(20) // FASE C.1: releitura confirma o estoque enviado (2*100*10%)
    // Leitura inicial (topo de syncPrices, monta o diff): tabela vazia --
    // produto ainda nao existe la, vai por addWakePriceTableProducts.
    // Readback pos-escrita (FASE C §9 / fix #4 Tech Lead PR #4): agora
    // direcionado por variantId, nao mais uma segunda varredura completa --
    // confirma o item recem-adicionado, senao o readback marcaria
    // 'failed'/'mismatch' e este teste, que so quer provar o payload do
    // Wake, quebraria.
    mockGetWakePriceTableProducts.mockResolvedValueOnce([])
    mockReadWakePriceTableByVariantId.mockResolvedValueOnce({ precoDe: moneyRound(3.6 * 1.3), precoPor: 3.6 })

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
    mockReadWakeStockByVariantId.mockResolvedValue(3) // FASE C.1: releitura confirma o estoque enviado (floor(17/5))

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
    mockReadWakeStockByVariantId.mockResolvedValue(2) // FASE C.1: releitura confirma o estoque enviado (floor(9/4))

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
    mockReadWakeStockByVariantId.mockResolvedValue(20) // FASE C.1: releitura confirma o estoque enviado (2*100*10%)

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

describe('runSync -- MOCK_PROVIDER_WRITE_BLOCKED (FASE C §3/§4)', () => {
  it('dryRun=false com CISS_PRICE_PROVIDER=mock: recusa ANTES de criar sync_run, zero chamada a qualquer escritor Wake', async () => {
    activePriceProviderName = 'mock'
    const product = await insertProduct({ wakeSku: 'SKU-MOCK-BLOCKED' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 5, unitRaw: 'PC' }])

    await expect(runSync({ kind: 'both', trigger: 'manual', dryRun: false })).rejects.toThrow('MOCK_PROVIDER_WRITE_BLOCKED')

    // Mesmo criterio do check de REQUIRED_UNCONFIRMED_KEYS: recusa antes de
    // criar a sync_run, entao nao sobra rastro de uma run que nunca rodou.
    const runs = await db.select().from(schema.syncRuns)
    expect(runs).toHaveLength(0)
    expect(mockUpdateWakePrices).not.toHaveBeenCalled()
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
  })

  it('dryRun=true com CISS_PRICE_PROVIDER=mock: guard nao se aplica -- calcula e planeja normalmente, zero escrita', async () => {
    activePriceProviderName = 'mock'
    const product = await insertProduct({ wakeSku: 'SKU-MOCK-DRYRUN' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 5, unitRaw: 'PC' }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: true })
    expect(result.status).toBe('success')
    expect(result.failedProducts).toBe(0)
    expect(mockUpdateWakePrices).not.toHaveBeenCalled()
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
  })
})

describe('runSync -- WAKE_STOCK_CONTROL_MODE=erp bloqueia escrita real de estoque (revisao Tech Lead PR #4, revisao final #2, item 1)', () => {
  it('fstore + kind=stock + dryRun=false: guard nao se aplica, escrita real de estoque prossegue', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-STOCKMODE-FSTORE-STOCK' })
    const variantId = Number(product.wakeProductVariantId)
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 5, unitRaw: 'PC' }])
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    mockReadWakeStockByVariantId.mockResolvedValue(5)

    const result = await runSync({ kind: 'stock', trigger: 'manual', dryRun: false })

    expect(result.status).toBe('success')
    expect(mockUpdateWakeStock).toHaveBeenCalledTimes(1)
  })

  it('fstore + kind=both + dryRun=false: guard nao se aplica, escrita real de preco+estoque prossegue', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-STOCKMODE-FSTORE-BOTH' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 5, unitRaw: 'PC' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 10 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    mockReadWakeStockByVariantId.mockResolvedValue(5)

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    expect(result.status).toBe('success')
    expect(mockUpdateWakeStock).toHaveBeenCalledTimes(1)
  })

  it('erp + kind=stock + dryRun=false: bloqueia ANTES de criar sync_run e ANTES de qualquer writer, erro explicito', async () => {
    process.env.WAKE_STOCK_CONTROL_MODE = 'erp'
    const product = await insertProduct({ wakeSku: 'SKU-STOCKMODE-ERP-STOCK' })
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 5, unitRaw: 'PC' }])

    await expect(runSync({ kind: 'stock', trigger: 'manual', dryRun: false })).rejects.toThrow('WAKE_STOCK_CONTROL_MODE_UNSUPPORTED_FOR_REAL_STOCK_SYNC')

    const runs = await db.select().from(schema.syncRuns)
    expect(runs).toHaveLength(0)
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockUpdateWakePrices).not.toHaveBeenCalled()
  })

  it('erp + kind=both + dryRun=false: bloqueia ANTES de criar sync_run e ANTES de qualquer writer (preco tambem nao roda)', async () => {
    process.env.WAKE_STOCK_CONTROL_MODE = 'erp'
    const product = await insertProduct({ wakeSku: 'SKU-STOCKMODE-ERP-BOTH' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 5, unitRaw: 'PC' }])

    await expect(runSync({ kind: 'both', trigger: 'manual', dryRun: false })).rejects.toThrow('WAKE_STOCK_CONTROL_MODE_UNSUPPORTED_FOR_REAL_STOCK_SYNC')

    const runs = await db.select().from(schema.syncRuns)
    expect(runs).toHaveLength(0)
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockUpdateWakePrices).not.toHaveBeenCalled()
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
  })

  it('erp + kind=price + dryRun=false: guard e especifico de estoque, NAO bloqueia sync de preco', async () => {
    process.env.WAKE_STOCK_CONTROL_MODE = 'erp'
    const product = await insertProduct({ wakeSku: 'SKU-STOCKMODE-ERP-PRICE' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 5, unitRaw: 'PC' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 10 })

    const result = await runSync({ kind: 'price', trigger: 'manual', dryRun: false })

    expect(result.status).toBe('success')
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
  })

  it('erp + kind=stock|both + dryRun=true: guard nao se aplica em dry-run, zero writer chamado', async () => {
    process.env.WAKE_STOCK_CONTROL_MODE = 'erp'
    const productStock = await insertProduct({ wakeSku: 'SKU-STOCKMODE-ERP-DRYRUN-STOCK' })
    mockFetchStockForProducts.mockResolvedValueOnce([{ productId: productStock.cissProductId, stock: 5, unitRaw: 'PC' }])

    const stockResult = await runSync({ kind: 'stock', trigger: 'manual', dryRun: true })
    expect(stockResult.status).toBe('success')
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()

    // Desativa o produto do sub-teste anterior antes do segundo runSync --
    // runSync varre TODOS os managedProducts com active=true, e este teste
    // roda duas chamadas na mesma unit test (sem reset de DB entre elas), sem
    // isso o segundo runSync tentaria reprocessar productStock sem preco/
    // estoque mockados pra ele e falharia por motivo alheio ao guard testado.
    await db.update(schema.managedProducts).set({ active: false }).where(eq(schema.managedProducts.id, productStock.id))

    const productBoth = await insertProduct({ wakeSku: 'SKU-STOCKMODE-ERP-DRYRUN-BOTH' })
    mockGetRetailPrices.mockResolvedValue(new Map([[productBoth.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValueOnce([{ productId: productBoth.cissProductId, stock: 5, unitRaw: 'PC' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 10 })

    const bothResult = await runSync({ kind: 'both', trigger: 'manual', dryRun: true })
    expect(bothResult.status).toBe('success')
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockUpdateWakePrices).not.toHaveBeenCalled()
  })
})

describe('runSync -- distincao MISMATCH vs FAILED na reconferencia de preco (FASE C §5/§6/§7)', () => {
  it('Wake aceita o PUT sem erro mas a releitura mostra outro valor: status mismatch (nao failed); lastApplied* nao avanca', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-PRICE-MISMATCH' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 5, unitRaw: 'PC' }])
    // Wake aceita a chamada (updateWakePrices resolve normal), mas a
    // releitura devolve um precoPor diferente do enviado (10) -- reproduz o
    // caso do SKU 7648 no caminho do preco unitario base.
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 9.5 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const priceItem = items.find((i) => i.field === 'unit_price')
    expect(priceItem?.status).toBe('mismatch')
    expect(priceItem?.errorMessage).toContain('encontrou valor diferente')
    expect(priceItem?.errorMessage).toContain('precoPor=9.5')

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.lastAppliedWakeUnitPrice).toBeNull()
  })

  it('Wake aceita o PUT mas o produto some na releitura: continua failed (nao mismatch)', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-PRICE-VANISHED' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 5, unitRaw: 'PC' }])
    mockGetWakeProductBySku.mockResolvedValue(null)
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })
    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const priceItem = items.find((i) => i.field === 'unit_price')
    expect(priceItem?.status).toBe('failed')
    expect(priceItem?.errorMessage).toContain('nao confirmou')
  })
})

describe('runSync -- read-after-write da Tabela de Preco 74 (FASE C §9)', () => {
  it('escrita aceita e releitura confirma precoPor/precoDe: status applied', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-T74-OK' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 3.6 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    mockReadWakeStockByVariantId.mockResolvedValue(20) // FASE C.1: releitura confirma o estoque enviado (2*100*10%)
    mockGetWakePriceTableProducts.mockResolvedValueOnce([])
    mockReadWakePriceTableByVariantId.mockResolvedValueOnce({ precoDe: moneyRound(3.6 * 1.3), precoPor: 3.6 })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const tableItem = items.find((i) => i.field === 'special_price')
    expect(tableItem?.status).toBe('applied')
    expect(result.status).toBe('success')
    expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledWith(variantId, 74)
  })

  it('escrita aceita mas a releitura mostra outro valor na tabela: status mismatch, run nao fica success', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-T74-MISMATCH' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 3.6 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    // Escrita aceita sem erro, mas a Tabela 74 continua mostrando o preco
    // antigo na releitura -- reproduz o bug historico do SKU 7648 (escrita
    // aceita, valor no Wake nunca mudou), agora pego pelo readback: antes
    // do FASE C isto seria marcado 'applied' sem nenhuma verificacao.
    mockGetWakePriceTableProducts.mockResolvedValueOnce([])
    mockReadWakePriceTableByVariantId.mockResolvedValueOnce({ precoDe: moneyRound(3 * 1.3), precoPor: 3 })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const tableItem = items.find((i) => i.field === 'special_price')
    expect(tableItem?.status).toBe('mismatch')
    expect(tableItem?.errorMessage).toContain('Tabela de Preco mostra')
    expect(result.status).not.toBe('success')
  })

  it('escrita aceita mas o SKU nao aparece na releitura: status failed (nao mismatch)', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-T74-GONE' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 3.6 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    mockGetWakePriceTableProducts.mockResolvedValueOnce([])
    mockReadWakePriceTableByVariantId.mockResolvedValueOnce(null)

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const tableItem = items.find((i) => i.field === 'special_price')
    expect(tableItem?.status).toBe('failed')
    expect(tableItem?.errorMessage).toContain('nao encontrado na Tabela de Preco')
  })

  it('revisao Tech Lead PR #4, fix #2: releitura final lanca (429/5xx/timeout/network) -- todos os writtenItems ficam failed, nunca mismatch, run partial/failed com trilha completa (teste A: 1 batch)', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-T74-READBACK-ERR' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 3.6 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    mockReadWakeStockByVariantId.mockResolvedValue(20)
    mockGetWakePriceTableProducts.mockResolvedValueOnce([])
    mockReadWakePriceTableByVariantId.mockRejectedValueOnce(new Error('ECONNRESET'))

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const tableItem = items.find((i) => i.field === 'special_price')
    expect(tableItem?.status).toBe('failed')
    expect(tableItem?.errorMessage).toContain('Falha ao reconferir a Tabela de Preço')
    expect(result.status).not.toBe('success')
  })

  it('revisao Tech Lead PR #4, revisao final #2, item 4: teste "3 batches" reescrito como multi-batch de verdade -- >100 produtos => 3 lotes reais de escrita (50+50+resto), todos os writes passam, todas as releituras falham, todos os itens ficam failed com trilha completa', async () => {
    // Achado da revisao final #2 (item 4): o teste anterior com esse nome
    // criava so 3 produtos -- com WAKE_BATCH_SIZE=50 isso e UM lote, nao
    // tres, o proprio comentario do teste antigo admitia isso. Este teste
    // reusa a estrutura do teste de fix #4 acima (>100 produtos, diff
    // inicial com 110 entradas alheias paginadas em 50+50+10) mas inverte o
    // resultado da releitura: aqui TODOS os GETs direcionados
    // (readWakePriceTableByVariantId) rejeitam, entao os itens dos 3 lotes
    // devem virar 'failed' -- nunca 'mismatch', nunca sem status.
    const CHANGED_COUNT = 110
    const products = await Promise.all(Array.from({ length: CHANGED_COUNT }, (_, i) => insertProduct({ wakeSku: `SKU-T74-MULTIBATCH-FAIL-${i + 1}` })))
    const variantIds = products.map((p) => Number(p.wakeProductVariantId))
    mockGetRetailPrices.mockResolvedValue(new Map(products.map((p) => [p.cissProductId, 300])))
    mockFetchStockForProducts.mockResolvedValue(products.map((p) => ({ productId: p.cissProductId, stock: 2, unitRaw: 'CT' })))
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 3.6 })
    mockUpdateWakeStock.mockResolvedValue({
      produtosAtualizados: variantIds.map((variantId) => ({ produtoVarianteId: variantId, resultado: true })),
      produtosNaoAtualizados: [],
    })
    mockReadWakeStockByVariantId.mockResolvedValue(20)

    const otherEntries = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({ sku: `SKU-OTHER-${start + i}`, precoDe: 10, precoPor: 7.5 }))
    mockGetWakePriceTableProducts
      // Leitura inicial (diff): tabela com 110 entradas ALHEIAS, paginada em
      // 3 chamadas (50+50+10) -- nenhuma bate com os SKUs deste teste, todos
      // os 110 produtos entram como ADD (existsInTable=false).
      .mockResolvedValueOnce(otherEntries(1, 50))
      .mockResolvedValueOnce(otherEntries(51, 50))
      .mockResolvedValueOnce(otherEntries(101, 10))
    // Todos os writes (addWakePriceTableProducts) tem sucesso -- so a
    // releitura pos-escrita falha, pra isolar exatamente o cenario do item
    // 4 (multi-batch real + readback com falha total).
    mockReadWakePriceTableByVariantId.mockRejectedValue(new Error('timeout'))

    vi.useFakeTimers()
    try {
      const resultPromise = runSync({ kind: 'both', trigger: 'manual', dryRun: false })
      await vi.runAllTimersAsync()
      const result = await resultPromise

      // 3 lotes de escrita reais (50+50+10) -- prova que o cenario tem B=3
      // de verdade, nao B=1 disfarcado de "3 batches" como no teste anterior.
      expect(mockAddWakePriceTableProducts).toHaveBeenCalledTimes(3)
      expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
      expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledTimes(CHANGED_COUNT)

      const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
      const tableItems = items.filter((i) => i.field === 'special_price')
      expect(tableItems).toHaveLength(CHANGED_COUNT)
      expect(tableItems.every((i) => i.status === 'failed')).toBe(true)
      expect(result.status).not.toBe('success')
    } finally {
      vi.useRealTimers()
    }
  }, 20000)

  it('revisao Tech Lead PR #4, fix #2 (teste C): outro caminho ja VERIFIED (estoque applied) + Table74 readback falha -- run partial, trilha completa preservada', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-T74-PARTIAL' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 3.6 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    mockReadWakeStockByVariantId.mockResolvedValue(20) // estoque confirma -> applied/verified nesse caminho
    mockGetWakePriceTableProducts.mockResolvedValueOnce([])
    mockReadWakePriceTableByVariantId.mockRejectedValueOnce(new Error('ECONNRESET'))

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const stockItem = items.find((i) => i.field === 'stock')
    const tableItem = items.find((i) => i.field === 'special_price')
    expect(stockItem?.status).toBe('applied')
    expect(tableItem?.status).toBe('failed')
    expect(result.status).toBe('partial')
  })

  it('revisao Tech Lead PR #4, fix #4 (teste A parcial): N SKUs alterados na Tabela 74 -- zero segunda varredura completa, releitura direcionada 1x por item escrito', async () => {
    const products = await Promise.all([1, 2, 3].map((i) => insertProduct({ wakeSku: `SKU-T74-BATCH-${i}` })))
    const variantIds = products.map((p) => Number(p.wakeProductVariantId))
    mockGetRetailPrices.mockResolvedValue(new Map(products.map((p) => [p.cissProductId, 300])))
    mockFetchStockForProducts.mockResolvedValue(products.map((p) => ({ productId: p.cissProductId, stock: 2, unitRaw: 'CT' })))
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 3.6 })
    mockUpdateWakeStock.mockResolvedValue({
      produtosAtualizados: variantIds.map((variantId) => ({ produtoVarianteId: variantId, resultado: true })),
      produtosNaoAtualizados: [],
    })
    mockReadWakeStockByVariantId.mockResolvedValue(20)
    // Unica chamada a getWakePriceTableProducts esperada: a leitura inicial
    // do diff. O fix #4 elimina o segundo full-scan -- a verificacao
    // pos-escrita agora e 1 GET direcionado por item via
    // readWakePriceTableByVariantId, nunca mais uma segunda varredura
    // paginada completa (o padrao que o §7 da revisao anterior classificou
    // como BLOCKER de performance).
    mockGetWakePriceTableProducts.mockResolvedValueOnce([])
    mockReadWakePriceTableByVariantId.mockResolvedValue({ precoDe: moneyRound(3.6 * 1.3), precoPor: 3.6 })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    expect(mockGetWakePriceTableProducts).toHaveBeenCalledTimes(1)
    expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledTimes(3)
    for (const variantId of variantIds) {
      expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledWith(variantId, 74)
    }
    expect(result.status).toBe('success')
  }, 15000)

  it('FASE D-PRE §2 / revisao Tech Lead PR #4 fix #4 (teste A): >100 entradas na Tabela 74 e >50 alteracoes em varios lotes de escrita -- 1 leitura paginada inicial + N leituras direcionadas serializadas, ZERO segundo full-scan', async () => {
    // Reproduz o achado do Tech Lead: a versao anterior do PR fazia uma
    // segunda varredura paginada completa apos os writes (2P GETs no total).
    // Sob o fix atual, o segundo full-scan desaparece -- o total de GETs
    // pos-escrita passa a ser N (1 por item escrito, serializado e
    // pacenado por WAKE_VERIFY_DELAY_MS), nunca P*algo.
    const priceResult = actualCalculateUnitPrice({ unitRaw: 'CT', cissPrice: 300 })
    if (!priceResult.ok) throw new Error('fixture invalida: CT deveria resolver como FIXADOR_CENTO')
    const targetPrecoPor = priceResult.retailPrice
    const targetPrecoDe = moneyRound(targetPrecoPor * 1.3)

    const CHANGED_COUNT = 110
    const products = await Promise.all(Array.from({ length: CHANGED_COUNT }, (_, i) => insertProduct({ wakeSku: `SKU-T74-BULK-${i + 1}` })))
    // Preco unitario ja aplicado e identico ao alvo -- prioriza isolar o
    // teste na Tabela 74 (evita os 110 sleeps de WAKE_VERIFY_DELAY_MS do
    // caminho de preco unitario, que nao e o que este teste audita).
    for (const product of products) {
      await db.insert(schema.syncProductState).values({
        managedProductId: product.id,
        lastAppliedWakeUnitPrice: targetPrecoPor,
        lastAppliedWakeSpecialPrice: priceResult.expectedWholesalePrice,
      })
    }
    mockGetRetailPrices.mockResolvedValue(new Map(products.map((p) => [p.cissProductId, 300])))
    mockFetchStockForProducts.mockResolvedValue(products.map((p) => ({ productId: p.cissProductId, stock: 2, unitRaw: 'CT' })))

    const otherEntries = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({ sku: `SKU-OTHER-${start + i}`, precoDe: 10, precoPor: 7.5 }))

    mockGetWakePriceTableProducts
      // Leitura inicial (diff, topo de syncPrices): tabela com 110 entradas
      // ALHEIAS (nenhuma bate com os SKUs deste teste) -- paginada em 3
      // chamadas (50+50+10). Esta e a UNICA leitura paginada da run inteira.
      .mockResolvedValueOnce(otherEntries(1, 50))
      .mockResolvedValueOnce(otherEntries(51, 50))
      .mockResolvedValueOnce(otherEntries(101, 10))
    // Readback pos-escrita: 1 GET direcionado por item, confirmando o valor
    // escrito -- nunca uma segunda pagina de getWakePriceTableProducts.
    mockReadWakePriceTableByVariantId.mockResolvedValue({ precoDe: targetPrecoDe, precoPor: targetPrecoPor })

    // Os 110 GETs direcionados sao serializados com WAKE_VERIFY_DELAY_MS
    // (650ms) entre cada um, exatamente como o Tech Lead exigiu (pacing
    // conservador, abaixo de 120 req/min) -- em tempo real isso levaria
    // ~71s. Fake timers avancam esse tempo sem esperar de verdade.
    vi.useFakeTimers()
    try {
      const resultPromise = runSync({ kind: 'price', trigger: 'manual', dryRun: false })
      await vi.runAllTimersAsync()
      const result = await resultPromise

      expect(result.status).toBe('success')
      // 3 lotes de escrita de fato ocorreram (50+50+10) -- confirma que o
      // cenario testado tem B=3, nao B=1.
      expect(mockAddWakePriceTableProducts).toHaveBeenCalledTimes(3)
      expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
      // Leitura paginada continua em 3 (so a leitura inicial do diff) --
      // NUNCA mais 6 (que seria 2 varreduras completas) nem 12 (o bug
      // original P*(1+B) com B=3).
      expect(mockGetWakePriceTableProducts).toHaveBeenCalledTimes(3)
      // Readback direcionado: exatamente 1 por item escrito, nunca uma
      // segunda varredura completa.
      expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledTimes(CHANGED_COUNT)

      const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
      const tableItems = items.filter((i) => i.field === 'special_price')
      expect(tableItems).toHaveLength(CHANGED_COUNT)
      expect(tableItems.every((i) => i.status === 'applied')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  }, 20000)

  it('revisao Tech Lead PR #4, fix #4 (teste B): multiplas tabelas no retorno do Wake -- seleciona estritamente a tabela alvo, nunca outra como fallback', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-T74-MULTITABLE' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 3.6 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    mockReadWakeStockByVariantId.mockResolvedValue(20)
    mockGetWakePriceTableProducts.mockResolvedValueOnce([])
    // O client real (readWakePriceTableByVariantId, testado isoladamente em
    // client.test.ts) e quem aplica o `.find(t => t.tabelaPrecoId === tableId)`
    // -- aqui o mock so precisa devolver o valor JA filtrado pra tabela 74,
    // simulando o que o client real devolveria mesmo com multiplas tabelas
    // na resposta do Wake (outra tabela, ex. 10, nunca deve ser usada como
    // fallback).
    mockReadWakePriceTableByVariantId.mockResolvedValueOnce({ precoDe: moneyRound(3.6 * 1.3), precoPor: 3.6 })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledWith(variantId, 74)
    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const tableItem = items.find((i) => i.field === 'special_price')
    expect(tableItem?.status).toBe('applied')
    expect(result.status).toBe('success')
  })

  it('revisao Tech Lead PR #4, fix #4 (teste F): dry-run -- leitura inicial permitida, special_price=planned, zero writers e zero readback pos-write', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-T74-DRYRUN' })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])
    mockGetWakePriceTableProducts.mockResolvedValueOnce([])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: true })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const tableItem = items.find((i) => i.field === 'special_price')
    expect(tableItem?.status).toBe('planned')
    expect(mockGetWakePriceTableProducts).toHaveBeenCalledTimes(1)
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockReadWakePriceTableByVariantId).not.toHaveBeenCalled()
  })

  it('revisao Tech Lead PR #4, revisao final #2, item 2 (teste A): mesmo lote com UPDATE (existentes) + ADD (novos) -- UPDATE sucesso, ADD falha -- UPDATE recebe readback e fica applied, ADD fica failed, run partial', async () => {
    // Achado da revisao final #2 (item 2): antes, updateWakePriceTableProducts
    // e addWakePriceTableProducts dividiam UM try/catch por lote -- se o
    // UPDATE tivesse sucesso e o ADD falhasse, o catch unico marcava o LOTE
    // INTEIRO como failed e os UPDATEs que ja tinham sido enviados com
    // sucesso nunca entravam em writtenItems (perdendo o readback e a chance
    // de virar 'applied'). Agora cada metade e independente.
    const [p1, p2, p3, p4] = await Promise.all([
      insertProduct({ wakeSku: 'SKU-T74-MIX-A-UPD-1' }),
      insertProduct({ wakeSku: 'SKU-T74-MIX-A-UPD-2' }),
      insertProduct({ wakeSku: 'SKU-T74-MIX-A-ADD-1' }),
      insertProduct({ wakeSku: 'SKU-T74-MIX-A-ADD-2' }),
    ])
    const products = [p1, p2, p3, p4]
    mockGetRetailPrices.mockResolvedValue(new Map(products.map((p) => [p.cissProductId, 300])))
    mockFetchStockForProducts.mockResolvedValue(products.map((p) => ({ productId: p.cissProductId, stock: 2, unitRaw: 'CT' })))

    const targetPrecoPor = 3.6
    const targetPrecoDe = moneyRound(targetPrecoPor * 1.3)
    // p1/p2 ja existem na Tabela 74 (leitura inicial do diff) com valor
    // DIFERENTE do alvo -- forca existsInTable=true (UPDATE). p3/p4 nao
    // aparecem nessa leitura -- forca existsInTable=false (ADD).
    mockGetWakePriceTableProducts.mockResolvedValueOnce([
      { sku: p1.wakeSku, precoDe: moneyRound(3 * 1.3), precoPor: 3 },
      { sku: p2.wakeSku, precoDe: moneyRound(3 * 1.3), precoPor: 3 },
    ])
    mockUpdateWakePriceTableProducts.mockResolvedValueOnce(undefined)
    mockAddWakePriceTableProducts.mockRejectedValueOnce(new Error('ADD indisponivel'))
    mockReadWakePriceTableByVariantId.mockResolvedValue({ precoDe: targetPrecoDe, precoPor: targetPrecoPor })

    const result = await runSync({ kind: 'price', trigger: 'manual', dryRun: false })

    expect(mockUpdateWakePriceTableProducts).toHaveBeenCalledTimes(1)
    expect(mockUpdateWakePriceTableProducts).toHaveBeenCalledWith(
      74,
      expect.arrayContaining([expect.objectContaining({ sku: p1.wakeSku }), expect.objectContaining({ sku: p2.wakeSku })]),
    )
    expect(mockAddWakePriceTableProducts).toHaveBeenCalledTimes(1)
    expect(mockAddWakePriceTableProducts).toHaveBeenCalledWith(
      74,
      expect.arrayContaining([expect.objectContaining({ sku: p3.wakeSku }), expect.objectContaining({ sku: p4.wakeSku })]),
    )
    // So os itens do UPDATE (que teve sucesso) entram no readback -- exatamente
    // o bug que este fix corrige: a falha do ADD nao pode derrubar o readback
    // dos UPDATEs que ja foram enviados com sucesso.
    expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledTimes(2)
    expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledWith(Number(p1.wakeProductVariantId), 74)
    expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledWith(Number(p2.wakeProductVariantId), 74)

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const tableItems = items.filter((i) => i.field === 'special_price')
    const bySku = new Map(tableItems.map((i) => [products.find((p) => p.id === i.managedProductId)?.wakeSku, i]))
    expect(bySku.get(p1.wakeSku)?.status).toBe('applied')
    expect(bySku.get(p2.wakeSku)?.status).toBe('applied')
    expect(bySku.get(p3.wakeSku)?.status).toBe('failed')
    expect(bySku.get(p4.wakeSku)?.status).toBe('failed')
    expect(bySku.get(p3.wakeSku)?.errorMessage).toContain('ADD indisponivel')
    expect(bySku.get(p4.wakeSku)?.errorMessage).toContain('ADD indisponivel')
    expect(result.status).toBe('partial')
  })

  it('revisao Tech Lead PR #4, revisao final #2, item 2 (teste B): UPDATE falha, ADD sucesso -- ADD ainda e tentado (nao e pulado por causa do UPDATE) e recebe readback; UPDATE fica failed', async () => {
    const [p1, p2, p3, p4] = await Promise.all([
      insertProduct({ wakeSku: 'SKU-T74-MIX-B-UPD-1' }),
      insertProduct({ wakeSku: 'SKU-T74-MIX-B-UPD-2' }),
      insertProduct({ wakeSku: 'SKU-T74-MIX-B-ADD-1' }),
      insertProduct({ wakeSku: 'SKU-T74-MIX-B-ADD-2' }),
    ])
    const products = [p1, p2, p3, p4]
    mockGetRetailPrices.mockResolvedValue(new Map(products.map((p) => [p.cissProductId, 300])))
    mockFetchStockForProducts.mockResolvedValue(products.map((p) => ({ productId: p.cissProductId, stock: 2, unitRaw: 'CT' })))

    const targetPrecoPor = 3.6
    const targetPrecoDe = moneyRound(targetPrecoPor * 1.3)
    mockGetWakePriceTableProducts.mockResolvedValueOnce([
      { sku: p1.wakeSku, precoDe: moneyRound(3 * 1.3), precoPor: 3 },
      { sku: p2.wakeSku, precoDe: moneyRound(3 * 1.3), precoPor: 3 },
    ])
    mockUpdateWakePriceTableProducts.mockRejectedValueOnce(new Error('UPDATE indisponivel'))
    mockAddWakePriceTableProducts.mockResolvedValueOnce(undefined)
    mockReadWakePriceTableByVariantId.mockResolvedValue({ precoDe: targetPrecoDe, precoPor: targetPrecoPor })

    const result = await runSync({ kind: 'price', trigger: 'manual', dryRun: false })

    // O ADD tem que ser tentado independente do resultado do UPDATE -- prova
    // de que as duas operacoes nao compartilham mais o mesmo try/catch.
    expect(mockUpdateWakePriceTableProducts).toHaveBeenCalledTimes(1)
    expect(mockAddWakePriceTableProducts).toHaveBeenCalledTimes(1)
    expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledTimes(2)
    expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledWith(Number(p3.wakeProductVariantId), 74)
    expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledWith(Number(p4.wakeProductVariantId), 74)

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const tableItems = items.filter((i) => i.field === 'special_price')
    const bySku = new Map(tableItems.map((i) => [products.find((p) => p.id === i.managedProductId)?.wakeSku, i]))
    expect(bySku.get(p1.wakeSku)?.status).toBe('failed')
    expect(bySku.get(p2.wakeSku)?.status).toBe('failed')
    expect(bySku.get(p1.wakeSku)?.errorMessage).toContain('UPDATE indisponivel')
    expect(bySku.get(p2.wakeSku)?.errorMessage).toContain('UPDATE indisponivel')
    expect(bySku.get(p3.wakeSku)?.status).toBe('applied')
    expect(bySku.get(p4.wakeSku)?.status).toBe('applied')
    expect(result.status).toBe('partial')
  })

  it('revisao Tech Lead PR #4, revisao final #2, item 2 (teste C): UPDATE e ADD ambos com sucesso -- todos os itens (dos dois grupos) entram no readback e ficam applied', async () => {
    const [p1, p2, p3, p4] = await Promise.all([
      insertProduct({ wakeSku: 'SKU-T74-MIX-C-UPD-1' }),
      insertProduct({ wakeSku: 'SKU-T74-MIX-C-UPD-2' }),
      insertProduct({ wakeSku: 'SKU-T74-MIX-C-ADD-1' }),
      insertProduct({ wakeSku: 'SKU-T74-MIX-C-ADD-2' }),
    ])
    const products = [p1, p2, p3, p4]
    mockGetRetailPrices.mockResolvedValue(new Map(products.map((p) => [p.cissProductId, 300])))
    mockFetchStockForProducts.mockResolvedValue(products.map((p) => ({ productId: p.cissProductId, stock: 2, unitRaw: 'CT' })))

    const targetPrecoPor = 3.6
    const targetPrecoDe = moneyRound(targetPrecoPor * 1.3)
    mockGetWakePriceTableProducts.mockResolvedValueOnce([
      { sku: p1.wakeSku, precoDe: moneyRound(3 * 1.3), precoPor: 3 },
      { sku: p2.wakeSku, precoDe: moneyRound(3 * 1.3), precoPor: 3 },
    ])
    mockUpdateWakePriceTableProducts.mockResolvedValueOnce(undefined)
    mockAddWakePriceTableProducts.mockResolvedValueOnce(undefined)
    mockReadWakePriceTableByVariantId.mockResolvedValue({ precoDe: targetPrecoDe, precoPor: targetPrecoPor })
    // Sem isso, o default do mock (mockGetWakeProductBySku -> null) faz a
    // releitura do preco unitario "sumir" e o item unit_price virar failed,
    // mascarando o resultado 'success' que este teste quer isolar (foco e
    // so no comportamento UPDATE+ADD da Tabela 74, nao no preco unitario).
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: targetPrecoPor })

    vi.useFakeTimers()
    try {
      const resultPromise = runSync({ kind: 'price', trigger: 'manual', dryRun: false })
      await vi.runAllTimersAsync()
      const result = await resultPromise

      expect(mockUpdateWakePriceTableProducts).toHaveBeenCalledTimes(1)
      expect(mockAddWakePriceTableProducts).toHaveBeenCalledTimes(1)
      expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledTimes(4)
      for (const p of products) {
        expect(mockReadWakePriceTableByVariantId).toHaveBeenCalledWith(Number(p.wakeProductVariantId), 74)
      }

      const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
      const tableItems = items.filter((i) => i.field === 'special_price')
      expect(tableItems).toHaveLength(4)
      expect(tableItems.every((i) => i.status === 'applied')).toBe(true)
      expect(result.status).toBe('success')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runSync -- distincao VERIFIED/MISMATCH/FAILED na reconferencia de estoque (FASE C.1 §2/§4/§5 -- BLOQUEIO PRINCIPAL da revisao do PR #3)', () => {
  it('A: ack aceito + releitura real confirma o valor enviado -> applied, lastAppliedWakeStock avanca', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-STOCK-VERIFIED' })
    const variantId = Number(product.wakeProductVariantId)
    await db.insert(schema.syncProductState).values({ managedProductId: product.id, lastAppliedWakeStock: 5 })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 7, unitRaw: 'PC' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 10 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    mockReadWakeStockByVariantId.mockResolvedValue(7)

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const stockItem = items.find((i) => i.field === 'stock')
    expect(stockItem?.status).toBe('applied')
    expect(mockReadWakeStockByVariantId).toHaveBeenCalledWith(variantId, 25)

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.lastAppliedWakeStock).toBe(7)
  })

  it('B: ack aceito mas a releitura real acha valor diferente -> mismatch (nao failed), lastAppliedWakeStock NAO avanca', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-STOCK-MISMATCH' })
    const variantId = Number(product.wakeProductVariantId)
    await db.insert(schema.syncProductState).values({ managedProductId: product.id, lastAppliedWakeStock: 5 })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 7, unitRaw: 'PC' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 10 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    // Wake aceita o PUT (ack ok) mas a releitura real mostra outro valor --
    // e exatamente a classe de bug que o ACK-only (pre-FASE C.1) nunca
    // conseguia detectar.
    mockReadWakeStockByVariantId.mockResolvedValue(3)

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const stockItem = items.find((i) => i.field === 'stock')
    expect(stockItem?.status).toBe('mismatch')
    expect(stockItem?.errorMessage).toContain('encontrou valor diferente')
    expect(stockItem?.errorMessage).toContain('estoqueFisico=3')

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.lastAppliedWakeStock).toBe(5)
  })

  it('C: Wake recusa o item no ack do lote -> failed, sem gastar nenhuma releitura, lastAppliedWakeStock NAO avanca', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-STOCK-ACK-REJECTED' })
    const variantId = Number(product.wakeProductVariantId)
    await db.insert(schema.syncProductState).values({ managedProductId: product.id, lastAppliedWakeStock: 5 })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 7, unitRaw: 'PC' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 10 })
    mockUpdateWakeStock.mockResolvedValue({
      produtosAtualizados: [],
      produtosNaoAtualizados: [{ produtoVarianteId: variantId, resultado: false, detalhes: 'Produto bloqueado' }],
    })

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const stockItem = items.find((i) => i.field === 'stock')
    expect(stockItem?.status).toBe('failed')
    expect(stockItem?.errorMessage).toContain('nao confirmou este item no ack do lote')
    // Item recusado no ACK nunca gasta uma releitura -- ja se sabe que o
    // Wake recusou (ver comentario em syncStock()).
    expect(mockReadWakeStockByVariantId).not.toHaveBeenCalled()

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.lastAppliedWakeStock).toBe(5)
  })

  it('D: ack aceito mas a releitura lanca erro de rede/protocolo -> failed (nunca mismatch), lastAppliedWakeStock NAO avanca', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-STOCK-READBACK-THROWS' })
    const variantId = Number(product.wakeProductVariantId)
    await db.insert(schema.syncProductState).values({ managedProductId: product.id, lastAppliedWakeStock: 5 })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 7, unitRaw: 'PC' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 10 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    mockReadWakeStockByVariantId.mockRejectedValue(new Error('ECONNRESET'))

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const stockItem = items.find((i) => i.field === 'stock')
    // Erro na PROPRIA releitura nunca vira 'mismatch' -- so um valor
    // diferente confirmado conta como mismatch; erro de rede/protocolo e
    // sempre 'failed', igual ao padrao ja usado pra preco e Tabela 74.
    expect(stockItem?.status).toBe('failed')
    expect(stockItem?.errorMessage).toContain('nao confirmou')
    // erro generico (nao WakeClientError) passa por String(err), que
    // prefixa "Error: " -- so WakeClientError usa err.message puro.
    expect(stockItem?.errorMessage).toContain('falha na releitura:')
    expect(stockItem?.errorMessage).toContain('ECONNRESET')

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.lastAppliedWakeStock).toBe(5)
  })

  it('E: estoque calculado ja igual ao ultimo aplicado -> no_change, zero chamada a escritor ou releitura de estoque', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-STOCK-NOOP' })
    await db.insert(schema.syncProductState).values({ managedProductId: product.id, lastAppliedWakeStock: 7 })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 7, unitRaw: 'PC' }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const stockItem = items.find((i) => i.field === 'stock')
    expect(stockItem?.status).toBe('no_change')
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockReadWakeStockByVariantId).not.toHaveBeenCalled()

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.lastAppliedWakeStock).toBe(7)
  })

  it('F: dry-run com estoque divergente -> planned, zero escritor/releitura real, lastAppliedWakeStock intocado', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-STOCK-DRYRUN-DIVERGE' })
    await db.insert(schema.syncProductState).values({ managedProductId: product.id, lastAppliedWakeStock: 5 })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 10]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 7, unitRaw: 'PC' }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: true })

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    const stockItem = items.find((i) => i.field === 'stock')
    expect(stockItem?.status).toBe('planned')
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockReadWakeStockByVariantId).not.toHaveBeenCalled()

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.lastAppliedWakeStock).toBe(5) // dry-run nunca toca lastApplied*
  })
})

describe('runSync -- fail-closed consolidado: zero escritor Wake pra qualquer motivo de recusa, numa unica run (FASE C.1 §9)', () => {
  it('UNSUPPORTED_UNIT + CONFIGURATION_REQUIRED (KG sem config) + NO_STOCK_RECORD misturados numa unica run: nenhum aciona qualquer escritor', async () => {
    const unsupported = await insertProduct({ wakeSku: 'SKU-FC-UNSUPPORTED' })
    const configRequired = await insertProduct({ wakeSku: 'SKU-FC-CONFIGREQ' })
    const noRecord = await insertProduct({ wakeSku: 'SKU-FC-NORECORD' })

    mockGetRetailPrices.mockResolvedValue(
      new Map([
        [unsupported.cissProductId, 10],
        [configRequired.cissProductId, 10],
        [noRecord.cissProductId, 10],
      ]),
    )
    mockFetchStockForProducts.mockResolvedValue([
      { productId: unsupported.cissProductId, stock: 10, unitRaw: 'XYZ' },
      { productId: configRequired.cissProductId, stock: 17, unitRaw: 'KG' },
      { productId: noRecord.cissProductId, stock: 0, noRecord: true, unitRaw: null },
    ])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })

    expect(result.appliedProducts).toBe(0)
    expect(result.failedProducts).toBe(6) // 3 produtos * (preco + estoque)

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    expect(items.every((i) => i.status === 'failed')).toBe(true)

    expect(mockUpdateWakePrices).not.toHaveBeenCalled()
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockGetWakeProductBySku).not.toHaveBeenCalled()
    expect(mockReadWakeStockByVariantId).not.toHaveBeenCalled()
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
  })
})

describe('runSync -- dry-run consolidado: zero escritor Wake e lastApplied* intocado, mesmo com preco/estoque/Tabela 74 todos divergentes (FASE C.1 §10)', () => {
  it('produto CT+FIXADOR_CENTO com preco, estoque e Tabela 74 todos divergentes do estado anterior: dryRun=true nao escreve nada em lugar nenhum', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-DRYRUN-ALL-DIVERGE' })
    await db.insert(schema.syncProductState).values({
      managedProductId: product.id,
      lastAppliedWakeUnitPrice: 2,
      lastAppliedWakeSpecialPrice: 1.5,
      lastAppliedWakeStock: 5,
    })
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])

    const result = await runSync({ kind: 'both', trigger: 'manual', dryRun: true })
    expect(result.status).toBe('success')
    expect(result.appliedProducts).toBe(0)

    const items = await db.select().from(schema.syncRunItems).where(eq(schema.syncRunItems.syncRunId, result.syncRunId))
    expect(items.every((i) => i.status === 'planned')).toBe(true)

    // FASE D-PRE §3: dry-run agora faz UMA leitura read-only da Tabela 74 pra
    // montar o preview -- e o item de special_price aparece no plano.
    const tablePriceItem = items.find((i) => i.field === 'special_price')
    expect(tablePriceItem?.status).toBe('planned')

    expect(mockUpdateWakePrices).not.toHaveBeenCalled()
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    expect(mockGetWakeProductBySku).not.toHaveBeenCalled()
    expect(mockReadWakeStockByVariantId).not.toHaveBeenCalled()
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockGetWakePriceTableProducts).toHaveBeenCalledTimes(1)

    const state = await db.select().from(schema.syncProductState).where(eq(schema.syncProductState.managedProductId, product.id)).get()
    expect(state?.lastAppliedWakeUnitPrice).toBe(2)
    expect(state?.lastAppliedWakeSpecialPrice).toBe(1.5)
    expect(state?.lastAppliedWakeStock).toBe(5)
  })
})

describe('runSync -- idempotencia: segunda run com os mesmos dados de origem e no-op (FASE C §10)', () => {
  it('rodar duas vezes seguidas sem mudanca no ERP: 2a run nao chama nenhum escritor Wake nem duplica na Tabela 74', async () => {
    const product = await insertProduct({ wakeSku: 'SKU-IDEMPOTENT' })
    const variantId = Number(product.wakeProductVariantId)
    mockGetRetailPrices.mockResolvedValue(new Map([[product.cissProductId, 300]]))
    mockFetchStockForProducts.mockResolvedValue([{ productId: product.cissProductId, stock: 2, unitRaw: 'CT' }])
    mockGetWakeProductBySku.mockResolvedValue({ precoPor: 3.6 })
    mockUpdateWakeStock.mockResolvedValue({ produtosAtualizados: [{ produtoVarianteId: variantId, resultado: true }], produtosNaoAtualizados: [] })
    mockReadWakeStockByVariantId.mockResolvedValue(20) // FASE C.1: releitura confirma o estoque enviado (2*100*10%)
    mockGetWakePriceTableProducts.mockResolvedValueOnce([])
    mockReadWakePriceTableByVariantId.mockResolvedValueOnce({ precoDe: moneyRound(3.6 * 1.3), precoPor: 3.6 })

    const firstRun = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })
    expect(firstRun.status).toBe('success')
    expect(mockUpdateWakePrices).toHaveBeenCalledTimes(1)
    expect(mockAddWakePriceTableProducts).toHaveBeenCalledTimes(1)

    // 2a run: mesmo CISS, mesmo Wake -- sync_product_state ja reflete o
    // valor aplicado (lastApplied*) e a Tabela 74 ja mostra o item presente
    // com o mesmo preco -- nada deveria ser reenviado.
    mockUpdateWakePrices.mockClear()
    mockUpdateWakeStock.mockClear()
    mockReadWakeStockByVariantId.mockClear()
    mockAddWakePriceTableProducts.mockClear()
    mockUpdateWakePriceTableProducts.mockClear()
    mockGetWakePriceTableProducts.mockReset().mockResolvedValue([{ sku: 'SKU-IDEMPOTENT', precoDe: moneyRound(3.6 * 1.3), precoPor: 3.6 }])

    const secondRun = await runSync({ kind: 'both', trigger: 'manual', dryRun: false })
    expect(secondRun.status).toBe('success')
    expect(secondRun.changedProducts).toBe(0)
    expect(mockUpdateWakePrices).not.toHaveBeenCalled()
    expect(mockUpdateWakeStock).not.toHaveBeenCalled()
    // FASE C.1 §11: idempotencia tambem cobre o novo caminho de releitura de
    // estoque -- lastAppliedWakeStock ja bate com o calculado (stockUnchanged),
    // entao a 2a run nem chega a tentar escrever nem a releitura real.
    expect(mockReadWakeStockByVariantId).not.toHaveBeenCalled()
    expect(mockAddWakePriceTableProducts).not.toHaveBeenCalled()
    expect(mockUpdateWakePriceTableProducts).not.toHaveBeenCalled()
  })
})
