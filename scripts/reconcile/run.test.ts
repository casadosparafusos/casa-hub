import { describe, expect, it } from 'vitest'
import type { ManagedProductRow } from './db-readonly'
import type { FetchLike } from './http'
import { toCsv } from './output'
import { runReconciliation, variantRange, type RunConfig } from './run'

const WAKE_TOKEN = 'wake-token-super-secreto'
const CISS_TOKEN = 'ciss-token-super-secreto'

const products: ManagedProductRow[] = [
  { id: 1, cissProductId: '100', wakeVariantId: '5001', wakeSku: 'A' },
  { id: 2, cissProductId: '200', wakeVariantId: '5002', wakeSku: 'B' },
  { id: 3, cissProductId: '300', wakeVariantId: '5003', wakeSku: 'C' },
]

const CISS = {
  '100': { unit: 'CT', price: 25, qty: 36.69 },
  '200': { unit: 'PC', price: 12.5, qty: 7 },
  '300': { unit: 'KG', price: 30, qty: 10 },
} as const

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function cissFetch(methods: string[]): FetchLike {
  return async (url, init) => {
    methods.push(init.method)
    const u = new URL(url)
    if (u.pathname.endsWith('/products/prices/search')) {
      const ids = (u.searchParams.get('product_ids') ?? '').split(',')
      return json({ data: ids.map((id) => ({ product_id: Number(id), retail_price: CISS[id as keyof typeof CISS]?.price ?? null })), pagination: { total_pages: 1 } })
    }
    if (u.pathname.endsWith('/products/stock')) {
      const id = u.searchParams.get('product_id') ?? ''
      const c = CISS[id as keyof typeof CISS]
      if (!c) return json({ data: [] })
      return json({ data: [{ product_id: Number(id), unit: c.unit, companies: [{ enterprise_id: 2, stocks: [{ location_id: 2, quantity: c.qty }] }] }] })
    }
    return json({ message: 'rota inesperada' }, 404)
  }
}

function wakeFetch(methods: string[], opts: { produtos429?: boolean } = {}): FetchLike {
  return async (url, init) => {
    methods.push(init.method)
    const u = new URL(url)
    if (u.pathname === '/produtos') {
      if (opts.produtos429) return json({ message: 'Too Many Requests' }, 429)
      return json(
        [
          { produtoVarianteId: 5001, sku: 'A', precoDe: 0.39, precoPor: 0.3, estoque: [{ centroDistribuicaoId: 25, estoqueFisico: 366 }] },
          { produtoVarianteId: 5002, sku: 'B', precoDe: 16.25, precoPor: 0.15, estoque: [{ centroDistribuicaoId: 25, estoqueFisico: 70 }] },
        ],
        200,
        { 'x-tem-proxima-pagina': 'false', 'x-ultimo-produto-variante-id': '5002' },
      )
    }
    if (u.pathname === '/tabelaPrecos/74/produtos') {
      return json([
        { sku: 'A', produtoVarianteId: 5001, precoDe: 0.39, precoPor: 0.3 },
        { sku: 'B', produtoVarianteId: 5002, precoDe: 0.2, precoPor: 0.15 },
      ])
    }
    if (u.pathname === '/promocoes/10365') {
      return json({
        dados: {
          estrutura: { nome: 'Atacado', ativo: true, dataInicio: '2026-01-01T00:00:00' },
          condicoes: [{ promocaoCondicaoId: 22, argumentos: [{ valor: '100' }] }],
          acoes: [{ promocaoAcaoId: 1, argumentos: [{ valor: '20' }] }],
        },
      })
    }
    return json({}, 404)
  }
}

function config(wakeMethods: string[], cissMethods: string[], wakeOpts: { produtos429?: boolean } = {}): RunConfig {
  const noSleep = { sleepFn: async () => {}, nowFn: () => 0 }
  return {
    products,
    wakeToken: WAKE_TOKEN,
    cissToken: CISS_TOKEN,
    wakeCdId: 25,
    priceTableId: 74,
    promotionId: 10365,
    cissEnterprise: 2,
    cissLocation: 2,
    wakeFetch: wakeFetch(wakeMethods, wakeOpts),
    cissFetch: cissFetch(cissMethods),
    cissBaseUrl: 'http://ciss.test/api/ciss',
    wakeOptions: noSleep,
    cissOptions: { sleepFn: async () => {} },
    useVariantRange: true,
    now: () => new Date('2026-09-10T12:00:00Z'),
  }
}

describe('runReconciliation', () => {
  it('fluxo completo com mocks: so GET, statuses por UNIT, promocao sem acao/escopo provados = UNVERIFIED', async () => {
    const wm: string[] = []
    const cm: string[] = []
    const report = await runReconciliation(config(wm, cm))
    expect(report.rows.map((r) => [r.wake_sku, r.status])).toEqual([
      ['A', 'MATCH'],
      ['B', 'PRICE_AND_STOCK_MISMATCH'], // PC com a Wake no formato HUNDRED
      ['C', 'CONFIGURATION_REQUIRED'], // KG sem kg_por_caixa
    ])
    // o mock so traz o argumento numerico 20 (sem descritor nem lista de produtos): nao prova acao/escopo
    expect(report.promotion_check?.status).toBe('UNVERIFIED')
    expect(report.promotion_check?.raw).toBeTruthy()
    expect(report.meta.aborted).toBe(false)
    expect(report.meta.wake_stock_verifiable).toBe(true)
    expect((report.meta.config as Record<string, unknown>).ciss_stock_concurrency).toBe(1)
    expect((report.meta.config as Record<string, unknown>).wake_products_extra_fields).toBe('Estoque')
    expect(report.meta.mode).toBe('READ_ONLY')
    expect(new Set([...wm, ...cm])).toEqual(new Set(['GET']))
    expect(report.meta.wake_requests).toBe(3)
    expect(report.meta.ciss_requests).toBe(4)
  })

  it('429 na Wake: aborta a Wake, CISS ainda e lido, linhas viram ERROR, promocao ERROR', async () => {
    const wm: string[] = []
    const cm: string[] = []
    const report = await runReconciliation(config(wm, cm, { produtos429: true }))
    expect(wm).toEqual(['GET']) // 1 request e parou -- nem tabela nem promocao
    expect(report.meta.aborted).toBe(true)
    expect(report.meta.wake_abort_status).toBe(429)
    expect(report.promotion_check?.status).toBe('ERROR')
    expect(report.rows.find((r) => r.wake_sku === 'A')).toMatchObject({ status: 'ERROR', unit: 'HUNDRED', expected_retail_price: 0.3 })
    expect(report.rows.find((r) => r.wake_sku === 'C')?.status).toBe('CONFIGURATION_REQUIRED')
    expect(report.aggregates.unit_hundred).toBe(1)
    expect(report.aggregates.wake_missing).toBe(0)
    expect(cm.length).toBeGreaterThan(0)
  })

  it('Wake sem estoque[] em /produtos: warning explicito, zero STOCK_MISMATCH, preco ainda reconciliado', async () => {
    const base = config([], [])
    const inner = base.wakeFetch
    const semEstoque: FetchLike = async (url, init) => {
      const res = await inner(url, init)
      if (new URL(url).pathname !== '/produtos') return res
      const body = (await res.json()) as Array<Record<string, unknown>>
      return json(
        body.map(({ estoque: _e, ...rest }) => rest),
        200,
        { 'x-tem-proxima-pagina': 'false', 'x-ultimo-produto-variante-id': '5002' },
      )
    }
    const report = await runReconciliation({ ...base, wakeFetch: semEstoque })
    expect(report.meta.wake_stock_verifiable).toBe(false)
    expect((report.meta.warnings as string[]).some((w) => w.includes('ESTOQUE WAKE NAO VERIFICAVEL'))).toBe(true)
    expect(report.aggregates.stock_mismatches).toBe(0)
    expect(report.aggregates.status_counts.STOCK_MISMATCH).toBe(0)
    expect(report.aggregates.stock_unverifiable).toBe(2)
    expect(report.rows.find((r) => r.wake_sku === 'A')).toMatchObject({ status: 'ERROR', price_match: true, stock_match: null })
  })

  it('CISS: default de concorrencia = 1 (nunca mais de 1 GET de estoque em voo)', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const base = cissFetch([])
    const counting: FetchLike = async (url, init) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      try {
        return await base(url, init)
      } finally {
        inFlight--
      }
    }
    await runReconciliation({ ...config([], []), cissFetch: counting })
    expect(maxInFlight).toBe(1)
  })

  it('relatorio e CSV nunca contem os tokens', async () => {
    const report = await runReconciliation(config([], []))
    const text = JSON.stringify(report) + toCsv(report.rows)
    expect(text).not.toContain(WAKE_TOKEN)
    expect(text).not.toContain(CISS_TOKEN)
    expect(text.toLowerCase()).not.toContain('authorization')
  })

  it('sem token Wake: nenhuma chamada a Wake', async () => {
    const wm: string[] = []
    const report = await runReconciliation({ ...config(wm, []), wakeToken: null })
    expect(wm).toEqual([])
    expect(report.meta.wake_abort_reason).toContain('ausente')
  })
})

describe('variantRange', () => {
  it('min/max dos ids', () => {
    expect(variantRange(products)).toEqual({ minVariantId: 5001, maxVariantId: 5003 })
  })
  it('id nao numerico = null (varredura completa)', () => {
    expect(variantRange([...products, { id: 9, cissProductId: '9', wakeVariantId: 'abc', wakeSku: 'X' }])).toBeNull()
  })
})
