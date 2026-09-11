import { describe, expect, it } from 'vitest'
import type { FetchLike } from './http'
import { analyzePromotion, toProductSnapshot, WakeAbortError, WakeHttpError, WakeReader } from './wake-reader'

interface Call {
  url: URL
  method: string
  auth: string | undefined
}

type Reply = { status: number; body?: unknown; headers?: Record<string, string> }

function mockFetch(handler: (url: URL, n: number) => Reply): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url)
    calls.push({ url: u, method: init.method, auth: init.headers.Authorization })
    const r = handler(u, calls.length)
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json', ...r.headers },
    })
  }
  return { fetchImpl, calls }
}

function fakeClock() {
  let t = 0
  const sleeps: number[] = []
  return {
    nowFn: () => t,
    sleepFn: async (ms: number) => {
      sleeps.push(ms)
      t += ms
    },
    sleeps,
  }
}

function productPage(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    produtoVarianteId: from + i,
    sku: `SKU${from + i}`,
    precoDe: 1.3,
    precoPor: 1,
    estoque: [
      { centroDistribuicaoId: 1, estoqueFisico: 999 },
      { centroDistribuicaoId: 25, estoqueFisico: from + i, estoqueReservado: 0 },
    ],
  }))
}

describe('WakeReader.scanProducts', () => {
  it('pagina por cursor produtoVarianteIdDe (exclusivo) com mais de 50 produtos, sem `pagina`', async () => {
    // Catalogo 1..120: paginas de 50, 50, 20.
    const { fetchImpl, calls } = mockFetch((u) => {
      const after = Number(u.searchParams.get('produtoVarianteIdDe') ?? '0')
      const rest = 120 - after
      const count = Math.min(50, rest)
      const last = after + count
      return {
        status: 200,
        body: productPage(after + 1, count),
        headers: {
          'x-tem-proxima-pagina': String(last < 120),
          'x-ultimo-produto-variante-id': String(last),
          'x-total-count': '120',
          'x-rate-limit-remaining': '100',
        },
      }
    })
    const clock = fakeClock()
    const reader = new WakeReader({ token: 'tok-secreto-123', fetchImpl, ...clock })
    const scan = await reader.scanProducts(25)

    expect(scan.products).toHaveLength(120)
    expect(scan.pages).toBe(3)
    expect(scan.stopReason).toBe('no_next_page')
    expect(scan.totalCountHeader).toBe(120)
    expect(scan.nonAscendingIds).toBe(false)
    expect(calls.map((c) => c.url.searchParams.get('produtoVarianteIdDe'))).toEqual([null, '50', '100'])
    for (const c of calls) {
      expect(c.method).toBe('GET')
      expect(c.url.pathname).toBe('/produtos')
      expect(c.url.searchParams.get('pagina')).toBeNull()
      expect(c.url.searchParams.get('quantidadeRegistros')).toBe('50')
      expect(c.url.searchParams.get('centrosDistribuicao')).toBe('25')
      // estoque explicito em TODA pagina
      expect(c.url.searchParams.get('camposAdicionais')).toBe('Estoque')
      expect(c.auth).toBe('BASIC tok-secreto-123')
      // token nunca na URL
      expect(c.url.toString()).not.toContain('tok-secreto-123')
    }
    // estoque do CD pedido (25), nao do primeiro da lista
    expect(scan.products[0]).toMatchObject({ variantId: 1, sku: 'SKU1', stockCd: 1, stockStatus: 'ok', precoPor: 1 })
    expect(scan).toMatchObject({ stockVerifiable: true, stockFieldPresent: 120, stockFieldMissing: 0, stockUnverifiableReason: null })
    // throttle: >= 2s entre requests (teto de 30 req/min)
    expect(clock.sleeps.filter((ms) => ms >= 2000)).toHaveLength(2)
  })

  it('com intervalo da whitelist: comeca em min-1 e para ao passar do max', async () => {
    const { fetchImpl, calls } = mockFetch((u) => {
      const after = Number(u.searchParams.get('produtoVarianteIdDe') ?? '0')
      return { status: 200, body: productPage(after + 1, 50), headers: { 'x-tem-proxima-pagina': 'true', 'x-ultimo-produto-variante-id': String(after + 50) } }
    })
    const reader = new WakeReader({ token: 't', fetchImpl, ...fakeClock() })
    const scan = await reader.scanProducts(25, { minVariantId: 1001, maxVariantId: 1080 })
    expect(calls.map((c) => c.url.searchParams.get('produtoVarianteIdDe'))).toEqual(['1000', '1050'])
    expect(calls.map((c) => c.url.searchParams.get('camposAdicionais'))).toEqual(['Estoque', 'Estoque'])
    expect(scan.stopReason).toBe('passed_whitelist_max')
    expect(scan.products).toHaveLength(100)
  })

  it('fail-safe: resposta sem estoque[] em nenhum produto = estoque NAO verificavel (erro explicito)', async () => {
    const page = productPage(1, 3).map(({ estoque: _e, ...rest }) => rest)
    const { fetchImpl } = mockFetch(() => ({ status: 200, body: page, headers: { 'x-tem-proxima-pagina': 'false', 'x-ultimo-produto-variante-id': '3' } }))
    const logs: string[] = []
    const scan = await new WakeReader({ token: 't', fetchImpl, ...fakeClock(), log: (m) => logs.push(m) }).scanProducts(25)
    expect(scan.stockVerifiable).toBe(false)
    expect(scan.stockFieldMissing).toBe(3)
    expect(scan.stockUnverifiableReason).toContain('nao verificavel')
    expect(scan.products.every((x) => x.stockStatus === 'no_field' && x.stockCd === null)).toBe(true)
    expect(logs.some((l) => l.includes('[wake] ERRO:'))).toBe(true)
  })

  it('para em pagina vazia', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 200, body: [] }))
    const scan = await new WakeReader({ token: 't', fetchImpl, ...fakeClock() }).scanProducts(25)
    expect(scan).toMatchObject({ pages: 1, stopReason: 'empty_page', products: [] })
  })

  it('cursor que nao avanca aborta', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 200, body: productPage(1, 50), headers: { 'x-tem-proxima-pagina': 'true', 'x-ultimo-produto-variante-id': '50' } }))
    await expect(new WakeReader({ token: 't', fetchImpl, ...fakeClock() }).scanProducts(25)).rejects.toBeInstanceOf(WakeAbortError)
  })

  it('429 aborta na hora, sem retry (1 request so)', async () => {
    const { fetchImpl, calls } = mockFetch((_u, n) =>
      n === 1
        ? { status: 200, body: productPage(1, 50), headers: { 'x-tem-proxima-pagina': 'true', 'x-ultimo-produto-variante-id': '50' } }
        : { status: 429, body: { message: 'Too Many Requests' } },
    )
    const reader = new WakeReader({ token: 't', fetchImpl, ...fakeClock() })
    const err = await reader.scanProducts(25).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WakeAbortError)
    expect((err as WakeAbortError).status).toBe(429)
    expect(calls).toHaveLength(2)
    expect(reader.requestCount).toBe(2)
  })

  it('401 aborta sem retry', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 401 }))
    await expect(new WakeReader({ token: 't', fetchImpl, ...fakeClock() }).get('/produtos')).rejects.toMatchObject({ status: 401 })
    expect(calls).toHaveLength(1)
  })

  it('5xx: 1 retry e depois aborta', async () => {
    const { fetchImpl, calls } = mockFetch(() => ({ status: 503 }))
    await expect(new WakeReader({ token: 't', fetchImpl, ...fakeClock() }).get('/produtos')).rejects.toBeInstanceOf(WakeAbortError)
    expect(calls).toHaveLength(2)
  })

  it('5xx seguido de 200 recupera', async () => {
    const { fetchImpl, calls } = mockFetch((_u, n) => (n === 1 ? { status: 502 } : { status: 200, body: [] }))
    const r = await new WakeReader({ token: 't', fetchImpl, ...fakeClock() }).get('/produtos')
    expect(r.json).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('404 vira WakeHttpError (nao aborta a execucao)', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 404, body: { message: 'nao encontrado' } }))
    await expect(new WakeReader({ token: 't', fetchImpl, ...fakeClock() }).get('/promocoes/1')).rejects.toBeInstanceOf(WakeHttpError)
  })

  it('rate-limit restante baixo pausa 60s antes do proximo request', async () => {
    const { fetchImpl } = mockFetch(() => ({ status: 200, body: [], headers: { 'x-rate-limit-remaining': '10' } }))
    const clock = fakeClock()
    const reader = new WakeReader({ token: 't', fetchImpl, ...clock })
    await reader.get('/produtos')
    await reader.get('/produtos')
    expect(clock.sleeps).toContain(60_000)
  })
})

describe('toProductSnapshot (status da leitura de estoque)', () => {
  it('ok / no_field / no_cd_entry / invalid_value', () => {
    expect(toProductSnapshot({ sku: 'A', estoque: [{ centroDistribuicaoId: 25, estoqueFisico: 0 }] }, 25)).toMatchObject({ stockStatus: 'ok', stockCd: 0 })
    expect(toProductSnapshot({ sku: 'A' }, 25)).toMatchObject({ stockStatus: 'no_field', stockCd: null })
    expect(toProductSnapshot({ sku: 'A', estoque: [{ centroDistribuicaoId: 1, estoqueFisico: 9 }] }, 25)).toMatchObject({ stockStatus: 'no_cd_entry', stockCd: null })
    expect(toProductSnapshot({ sku: 'A', estoque: [{ centroDistribuicaoId: 25, estoqueFisico: null }] }, 25)).toMatchObject({ stockStatus: 'invalid_value', stockCd: null })
  })
})

describe('WakeReader.readPriceTable', () => {
  it('pagina com `pagina` ate pagina incompleta', async () => {
    const { fetchImpl, calls } = mockFetch((u) => {
      const pagina = Number(u.searchParams.get('pagina'))
      const count = pagina === 1 ? 50 : 3
      return { status: 200, body: Array.from({ length: count }, (_, i) => ({ sku: `S${pagina}-${i}`, produtoVarianteId: i, precoDe: 1.3, precoPor: 1 })) }
    })
    const r = await new WakeReader({ token: 't', fetchImpl, ...fakeClock() }).readPriceTable(74)
    expect(r.pages).toBe(2)
    expect(r.entries).toHaveLength(53)
    expect(calls[0]?.url.pathname).toBe('/tabelaPrecos/74/produtos')
  })
})

describe('analyzePromotion (estrito)', () => {
  const now = new Date('2026-09-10T12:00:00Z')
  const expected = { min_qty: 100, percent: 20 }
  const whitelist = [
    { sku: 'A', variantId: 5001 },
    { sku: 'B', variantId: 5002 },
  ]
  // Formato "minimo": sem descritor de acao nem lista explicita de produtos.
  const dados = {
    estrutura: { nome: 'Atacado 100+', ativo: true, dataInicio: '2026-01-01T00:00:00', dataTermino: null },
    condicoes: [{ promocaoCondicaoId: 22, argumentos: [{ nrOrdem: 1, valor: '100' }] }],
    acoes: [{ promocaoAcaoId: 3, argumentos: [{ nrOrdem: 1, valor: '20' }] }],
  }
  // Formato em que acao e escopo sao provaveis pela estrutura.
  const acaoProvada = { promocaoAcaoId: 3, nome: 'Desconto percentual', argumentos: [{ nrOrdem: 1, valor: '20' }], produtos: [{ sku: 'A' }, { produtoVarianteId: 5002 }] }
  const provado = { ...dados, acoes: [acaoProvada] }

  it('argumento numerico "20" sozinho NAO da PASS: UNVERIFIED, raw preservado', () => {
    const r = analyzePromotion(10365, dados, now, expected, whitelist)
    expect(r.status).toBe('UNVERIFIED')
    expect(r.checks).toEqual({ ativo: true, vigente: true, quantidade: true, acao: null, escopo: null })
    expect(r.action_numeric_values).toEqual([20])
    expect(r.raw).toBe(dados)
    expect(r.notes.join(' ')).toContain('acao nao determinavel')
    expect(r.notes.join(' ')).toContain('escopo nao determinavel')
  })

  it('PASS so quando ativo, vigente, quantidade 100, desconto percentual 20 e escopo cobrindo a whitelist', () => {
    const r = analyzePromotion(10365, provado, now, expected, whitelist)
    expect(r.status).toBe('PASS')
    expect(r.checks).toEqual({ ativo: true, vigente: true, quantidade: true, acao: true, escopo: true })
    expect(r.scope).toMatchObject({ source: 'acoes[0].produtos', whitelist_count: 2, covered: 2, missing_sample: [] })
  })

  it('escopo explicito que nao cobre a whitelist = FAIL', () => {
    const r = analyzePromotion(10365, provado, now, expected, [...whitelist, { sku: 'Z', variantId: 9 }])
    expect(r.status).toBe('FAIL')
    expect(r.checks.escopo).toBe(false)
    expect(r.scope.missing_sample).toEqual(['Z'])
  })

  it('desconto percentual com outro valor = FAIL na acao', () => {
    const d = { ...provado, acoes: [{ ...acaoProvada, argumentos: [{ valor: '15' }] }] }
    const r = analyzePromotion(10365, d, now, expected, whitelist)
    expect(r.status).toBe('FAIL')
    expect(r.checks.acao).toBe(false)
  })

  it('descritor que nao e percentual (desconto em valor) com 20 = acao nao provada', () => {
    const d = { ...provado, acoes: [{ ...acaoProvada, nome: 'Desconto em valor' }] }
    const r = analyzePromotion(10365, d, now, expected, whitelist)
    expect(r.checks.acao).toBeNull()
    expect(r.status).toBe('UNVERIFIED')
  })

  it('FAIL quando a quantidade difere', () => {
    const d = { ...provado, condicoes: [{ promocaoCondicaoId: 22, argumentos: [{ valor: 50 }] }] }
    expect(analyzePromotion(10365, d, now, expected, whitelist)).toMatchObject({ status: 'FAIL', checks: { quantidade: false } })
  })

  it('UNVERIFIED quando a condicao 22 nao existe', () => {
    const d = { ...provado, condicoes: [] }
    expect(analyzePromotion(10365, d, now, expected, whitelist).status).toBe('UNVERIFIED')
  })

  it('FAIL quando inativa', () => {
    const d = { ...provado, estrutura: { ...provado.estrutura, ativo: false } }
    expect(analyzePromotion(10365, d, now, expected, whitelist).status).toBe('FAIL')
  })

  it('FAIL quando fora da vigencia', () => {
    const d = { ...provado, estrutura: { ...provado.estrutura, dataTermino: '2026-02-01T00:00:00' } }
    expect(analyzePromotion(10365, d, now, expected, whitelist)).toMatchObject({ status: 'FAIL', checks: { vigente: false } })
  })
})
