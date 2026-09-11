import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CissAbortError, CissReader } from './ciss-reader'
import { parseCensusArgs } from './cli-args'
import type { FetchLike } from './http'
import { writeCensusArtifacts } from './output'
import { aggregateUnits, mapUnit, normalizeUnit, probeStockListing, readCatalogUnits, type CatalogProduct } from './unit-census'

const BASE = 'http://ciss.test/api/ciss'

function mock(handler: (u: URL) => { status: number; body?: unknown; raw?: string }): { fetchImpl: FetchLike; urls: URL[]; methods: string[] } {
  const urls: URL[] = []
  const methods: string[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    methods.push(init.method)
    const u = new URL(url)
    urls.push(u)
    const r = handler(u)
    const text = r.raw ?? (r.body === undefined ? '' : JSON.stringify(r.body))
    return new Response(text, { status: r.status, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, urls, methods }
}

function item(id: number, unit: string | null, extra: Record<string, unknown> = {}) {
  return {
    product_id: id,
    description: `PRODUTO ${id}`,
    reference: `REF${id}`,
    unit,
    companies: [{ enterprise_id: 2, stocks: [{ location_id: 2, quantity: 123.45 }] }],
    ...extra,
  }
}

/** Catalogo paginado de verdade: page/per_page respeitados. */
function catalogServer(all: Array<ReturnType<typeof item>>) {
  return (u: URL) => {
    const page = Number(u.searchParams.get('page'))
    const per = Number(u.searchParams.get('per_page'))
    const data = all.slice((page - 1) * per, page * per)
    return { status: 200, body: { data, pagination: { page, per_page: per, total: all.length, total_pages: Math.max(1, Math.ceil(all.length / per)) } } }
  }
}

const noSleep = async () => {}

describe('probeStockListing', () => {
  it('exatamente 1 GET sem product_id; 200 + data[] + paginacao = LISTING_SUPPORTED', async () => {
    const { fetchImpl, urls, methods } = mock(catalogServer([item(1, 'CT'), item(2, 'PC')]))
    const r = await probeStockListing({ token: 'tok-secreto-123', fetchImpl, baseUrl: BASE, perPage: 500, timeoutMs: 1000 })
    expect(urls).toHaveLength(1)
    expect(methods).toEqual(['GET'])
    expect(urls[0]?.pathname).toBe('/api/ciss/products/stock')
    expect(urls[0]?.searchParams.get('page')).toBe('1')
    expect(urls[0]?.searchParams.get('per_page')).toBe('500')
    expect(urls[0]?.searchParams.has('product_id')).toBe(false)
    expect(r.verdict).toBe('LISTING_SUPPORTED')
    expect(r.pagination).toEqual({ page: 1, per_page: 500, total: 2, total_pages: 1 })
    expect(r.items_with_unit_field).toBe(2)
    expect(r.item_keys).toEqual(['companies', 'description', 'product_id', 'reference', 'unit'])
  })

  it('probe nao expoe valores (quantidade, descricao, token)', async () => {
    const { fetchImpl } = mock(catalogServer([item(1, 'CT')]))
    const text = JSON.stringify(await probeStockListing({ token: 'tok-secreto-123', fetchImpl, baseUrl: BASE, perPage: 500, timeoutMs: 1000 }))
    expect(text).not.toContain('123.45')
    expect(text).not.toContain('PRODUTO 1')
    expect(text).not.toContain('tok-secreto-123')
  })

  it('400 (product_id obrigatorio) = LISTING_NOT_SUPPORTED, sem retry', async () => {
    const { fetchImpl, urls } = mock(() => ({ status: 400, body: { error: 'product_id obrigatorio' } }))
    const r = await probeStockListing({ token: 't', fetchImpl, baseUrl: BASE, perPage: 500, timeoutMs: 1000 })
    expect(urls).toHaveLength(1)
    expect(r.verdict).toBe('LISTING_NOT_SUPPORTED')
    expect(r.http_status).toBe(400)
    expect(r.error).toContain('product_id obrigatorio')
  })

  it('200 sem paginacao = UNEXPECTED_RESPONSE; 500 tambem, sem retry', async () => {
    const a = mock(() => ({ status: 200, body: { data: [] } }))
    expect((await probeStockListing({ token: 't', fetchImpl: a.fetchImpl, baseUrl: BASE, perPage: 500, timeoutMs: 1000 })).verdict).toBe('UNEXPECTED_RESPONSE')
    const b = mock(() => ({ status: 500, raw: '<html>erro</html>' }))
    const r = await probeStockListing({ token: 't', fetchImpl: b.fetchImpl, baseUrl: BASE, perPage: 500, timeoutMs: 1000 })
    expect(b.urls).toHaveLength(1)
    expect(r.verdict).toBe('UNEXPECTED_RESPONSE')
    expect(r.http_status).toBe(500)
  })
})

describe('readCatalogUnits', () => {
  const all = Array.from({ length: 1203 }, (_, i) => item(i + 1, i % 3 === 0 ? 'PC' : 'CT'))

  it('percorre todas as paginas sequencialmente e guarda so 4 campos', async () => {
    const { fetchImpl, urls } = mock(catalogServer(all))
    const sleeps: number[] = []
    const reader = new CissReader({ token: 't', fetchImpl, baseUrl: BASE, sleepFn: noSleep })
    const r = await readCatalogUnits(reader, { perPage: 500, pageDelayMs: 1000, maxPages: 10, sleepFn: async (ms) => void sleeps.push(ms) })
    expect(urls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2', '3'])
    expect(urls.every((u) => !u.searchParams.has('product_id'))).toBe(true)
    expect(sleeps).toEqual([1000, 1000])
    expect(r.products).toHaveLength(1203)
    expect(r.pages_read).toBe(3)
    expect(r.requests).toBe(3)
    expect(r.reported_total).toBe(1203)
    expect(r.warnings).toEqual([])
    for (const p of r.products) expect(Object.keys(p).sort()).toEqual(['description', 'product_id', 'reference', 'unit_raw'])
    expect(JSON.stringify(r)).not.toContain('123.45')
  })

  it('paginacao ignorada pelo servidor (sempre a pagina 1) aborta', async () => {
    const { fetchImpl } = mock((u) => {
      const per = Number(u.searchParams.get('per_page'))
      return { status: 200, body: { data: all.slice(0, per), pagination: { page: 1, per_page: per, total: all.length, total_pages: 3 } } }
    })
    const reader = new CissReader({ token: 't', fetchImpl, baseUrl: BASE, sleepFn: noSleep })
    await expect(readCatalogUnits(reader, { perPage: 500, pageDelayMs: 0, maxPages: 10, sleepFn: noSleep })).rejects.toThrow(/paginacao ignorada/)
  })

  it('teto de paginas aborta', async () => {
    const { fetchImpl } = mock(catalogServer(all))
    const reader = new CissReader({ token: 't', fetchImpl, baseUrl: BASE, sleepFn: noSleep })
    await expect(readCatalogUnits(reader, { perPage: 100, pageDelayMs: 0, maxPages: 5, sleepFn: noSleep })).rejects.toThrow(/limite de 5 paginas/)
  })

  it('401 aborta tudo', async () => {
    const { fetchImpl } = mock(() => ({ status: 401 }))
    const reader = new CissReader({ token: 't', fetchImpl, baseUrl: BASE, sleepFn: noSleep })
    await expect(readCatalogUnits(reader, { perPage: 500, pageDelayMs: 0, maxPages: 10, sleepFn: noSleep })).rejects.toBeInstanceOf(CissAbortError)
  })

  it('500 persistente aborta apos o retry limitado do reader', async () => {
    const { fetchImpl, urls } = mock(() => ({ status: 500 }))
    const reader = new CissReader({ token: 't', fetchImpl, baseUrl: BASE, sleepFn: noSleep, maxAttempts: 3 })
    await expect(readCatalogUnits(reader, { perPage: 500, pageDelayMs: 0, maxPages: 10, sleepFn: noSleep })).rejects.toThrow(/CISS 500/)
    expect(urls).toHaveLength(3)
  })

  it('product_id repetido entre paginas conta como duplicado e avisa se unit diverge', async () => {
    const data = [item(1, 'CT'), item(2, 'PC'), item(2, 'UN'), item(3, 'KG')]
    const { fetchImpl } = mock(catalogServer(data))
    const reader = new CissReader({ token: 't', fetchImpl, baseUrl: BASE, sleepFn: noSleep })
    const r = await readCatalogUnits(reader, { perPage: 2, pageDelayMs: 0, maxPages: 10, sleepFn: noSleep })
    expect(r.products.map((p) => p.product_id)).toEqual(['1', '2', '3'])
    expect(r.duplicates).toBe(1)
    expect(r.warnings.some((w) => w.includes('unit diferente'))).toBe(true)
  })
})

describe('aggregateUnits / dicionario', () => {
  const products: CatalogProduct[] = [
    ...Array.from({ length: 7 }, (_, i) => ({ product_id: String(i + 1), reference: `R${i + 1}`, description: 'x', unit_raw: 'CT' })),
    { product_id: '20', reference: 'R20', description: 'x', unit_raw: ' ct ' },
    { product_id: '30', reference: 'R30', description: 'x', unit_raw: 'PC' },
    { product_id: '40', reference: null, description: 'x', unit_raw: 'KG' },
    { product_id: '50', reference: 'R50', description: 'x', unit_raw: 'MT' },
    { product_id: '60', reference: 'R60', description: 'x', unit_raw: null },
    { product_id: '70', reference: 'R70', description: 'x', unit_raw: '' },
  ]

  it('normaliza com trim + uppercase e marca ausente/vazio', () => {
    expect(normalizeUnit(' ct ')).toBe('CT')
    expect(normalizeUnit(null)).toBe('(AUSENTE)')
    expect(normalizeUnit('  ')).toBe('(VAZIO)')
  })

  it('unidade desconhecida NUNCA vira PC nem CENTO', () => {
    for (const u of ['MT', 'CX', 'CENTO', 'PCT', 'UND', '(AUSENTE)', '(VAZIO)', 'cT']) {
      const m = mapUnit(u)
      expect(m.canonical).toBe('UNSUPPORTED')
      expect(m.strategy).toBe('FUTURE_RULE')
    }
    expect(mapUnit('CT')).toMatchObject({ canonical: 'CENTO', status: 'CANDIDATE / OWNER_CONFIRMATION_REQUIRED' })
    expect(mapUnit('PC').canonical).toBe('PIECE')
    expect(mapUnit('UN').canonical).toBe('PIECE')
    expect(mapUnit('KG').canonical).toBe('KG_PACKAGE')
    expect(mapUnit('constructor').canonical).toBe('UNSUPPORTED')
  })

  it('agrega raw e normalizado, ate 5 exemplos, e cruza com a whitelist', () => {
    const agg = aggregateUnits(products, ['1', '2', '20', '30', '40', '50', '999'])
    const rawCt = agg.raw.find((r) => r.unit_raw === 'CT')
    expect(rawCt).toMatchObject({ unit_normalized: 'CT', count_catalog: 7, count_current_whitelist: 2 })
    expect(rawCt?.example_product_ids).toHaveLength(5)
    expect(rawCt?.example_references).toEqual(['R1', 'R2', 'R3', 'R4', 'R5'])
    expect(agg.raw.find((r) => r.unit_raw === ' ct ')?.count_catalog).toBe(1)
    const normCt = agg.normalized.find((n) => n.unit_normalized === 'CT')
    expect(normCt).toMatchObject({ count_catalog: 8, count_current_whitelist: 3, canonical: 'CENTO', raw_variants: ['CT', ' ct '] })
    expect(agg.normalized[0]?.unit_normalized).toBe('CT')
    expect(agg.normalized.find((n) => n.unit_normalized === 'MT')?.canonical).toBe('UNSUPPORTED')
    expect(agg.whitelist).toEqual({
      total: 7,
      by_category: { CT: 3, PC: 1, UN: 0, KG: 1, OUTRAS: 1, SEM_REGISTRO: 1 },
      outras_detail: { MT: 1 },
      sem_registro_product_ids: ['999'],
    })
  })
})

describe('artefatos do censo', () => {
  it('grava json+csv sem preco/estoque e recusa se houver segredo', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'))
    const rows = [{ product_id: '1', reference: 'R1', description: 'PARAF, "X"', unit_raw: 'CT', unit_normalized: 'CT', in_current_whitelist: true }]
    const { csvPath, jsonPath } = writeCensusArtifacts(dir, '20260911-1200', { meta: { writes: 0 } }, rows, ['segredo-muito-longo'])
    const csv = fs.readFileSync(csvPath, 'utf8')
    expect(csv.split('\n')[0]).toBe('product_id,reference,description,unit_raw,unit_normalized,in_current_whitelist')
    expect(csv).toContain('"PARAF, ""X"""')
    expect(csv).not.toMatch(/price|stock|quantity/i)
    expect(fs.existsSync(jsonPath)).toBe(true)
    expect(() => writeCensusArtifacts(dir, '20260911-1201', { meta: { leak: 'segredo-muito-longo' } }, rows, ['segredo-muito-longo'])).toThrow(/segredo/)
    expect(fs.existsSync(path.join(dir, 'ciss-unit-census-20260911-1201.json'))).toBe(false)
  })

  it('args: defaults e limites (per_page <= 500)', () => {
    const a = parseCensusArgs(['--probe'])
    expect(a).toMatchObject({ probe: true, perPage: 500, pageDelayMs: 1000, maxPages: 400 })
    expect(() => parseCensusArgs(['--per-page', '1000'])).toThrow()
    expect(() => parseCensusArgs(['--page-delay-ms', '0'])).toThrow()
    expect(() => parseCensusArgs(['--x'])).toThrow()
  })
})
