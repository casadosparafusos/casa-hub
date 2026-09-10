import { describe, expect, it } from 'vitest'
import { CissAbortError, CissReader } from './ciss-reader'
import type { FetchLike } from './http'

function mock(handler: (u: URL) => { status: number; body?: unknown }): { fetchImpl: FetchLike; urls: URL[] } {
  const urls: URL[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    expect(init.method).toBe('GET')
    const u = new URL(url)
    urls.push(u)
    const r = handler(u)
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, urls }
}

const opts = { token: 't', baseUrl: 'http://ciss.test/api/ciss', sleepFn: async () => {} }

describe('CissReader', () => {
  it('estoque preserva product_id, unit, enterprise, location e quantity', async () => {
    const { fetchImpl, urls } = mock(() => ({
      status: 200,
      body: {
        data: [
          {
            product_id: 7,
            unit: 'CENTO',
            description: 'PARAFUSO',
            companies: [
              { enterprise_id: 1, stocks: [{ location_id: 2, quantity: 999 }] },
              { enterprise_id: 2, stocks: [{ location_id: 5, quantity: 1 }, { location_id: 2, quantity: 36.69 }] },
            ],
          },
        ],
      },
    }))
    const rec = await new CissReader({ ...opts, fetchImpl }).readStock('7', { enterprise: 2, location: 2 })
    expect(rec).toMatchObject({ productId: '7', found: true, unitRaw: 'CENTO', enterprise: 2, location: 2, quantity: 36.69, locationPresent: true })
    expect(urls[0]?.pathname).toBe('/api/ciss/products/stock')
    expect(urls[0]?.searchParams.get('product_id')).toBe('7')
  })

  it('data:[] = sem registro (found false), nunca inventa unit', async () => {
    const { fetchImpl } = mock(() => ({ status: 200, body: { data: [] } }))
    const rec = await new CissReader({ ...opts, fetchImpl }).readStock('8', { enterprise: 2, location: 2 })
    expect(rec).toMatchObject({ found: false, unitRaw: null, quantity: 0 })
  })

  it('empresa/local ausente = zero legitimo, sinalizado', async () => {
    const { fetchImpl } = mock(() => ({ status: 200, body: { data: [{ product_id: 9, unit: 'PC', companies: [] }] } }))
    const rec = await new CissReader({ ...opts, fetchImpl }).readStock('9', { enterprise: 2, location: 2 })
    expect(rec).toMatchObject({ found: true, unitRaw: 'PC', quantity: 0, locationPresent: false })
  })

  it('401 derruba a leitura inteira', async () => {
    const { fetchImpl } = mock(() => ({ status: 401 }))
    await expect(new CissReader({ ...opts, fetchImpl }).readStockMany(['1', '2'], { enterprise: 2, location: 2 })).rejects.toBeInstanceOf(CissAbortError)
  })

  it('500 persistente vira erro por produto (os demais seguem)', async () => {
    const { fetchImpl } = mock((u) =>
      u.searchParams.get('product_id') === '1' ? { status: 500 } : { status: 200, body: { data: [{ product_id: 2, unit: 'UN', companies: [] }] } },
    )
    const out = await new CissReader({ ...opts, fetchImpl }).readStockMany(['1', '2'], { enterprise: 2, location: 2 })
    expect(out.get('1')?.ok).toBe(false)
    expect(out.get('2')?.ok).toBe(true)
  })

  it('precos em lotes de 150, product_id ausente fica fora do Map, null preservado', async () => {
    const { fetchImpl, urls } = mock((u) => {
      const ids = (u.searchParams.get('product_ids') ?? '').split(',')
      return { status: 200, body: { data: ids.filter((id) => id !== '5').map((id) => ({ product_id: Number(id), retail_price: id === '6' ? null : 10 })), pagination: { total_pages: 1 } } }
    })
    const ids = Array.from({ length: 160 }, (_, i) => String(i + 1))
    const prices = await new CissReader({ ...opts, fetchImpl }).readPrices(ids)
    expect(urls).toHaveLength(2)
    expect(urls[0]?.searchParams.get('per_page')).toBe('500')
    expect(prices.has('5')).toBe(false)
    expect(prices.get('6')).toBeNull()
    expect(prices.get('7')).toBe(10)
  })
})
