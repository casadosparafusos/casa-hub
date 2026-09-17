import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// FASE C §11: ciss/client.ts nao tinha nenhum teste dedicado -- so cobertura
// indireta via engine.test.ts, que mocka '../ciss/price-provider' inteiro e
// nunca exercita cissGet()/backoff() de verdade. Este arquivo prova o
// contrato de retry: transiente (429/5xx/timeout) tenta ate MAX_RETRIES vezes
// com backoff exponencial, permanente (4xx != 429) nunca tenta de novo.

vi.mock('server-only', () => ({}))

const mockGetSecret = vi.fn<(key: string) => Promise<string | null>>()
vi.mock('@/lib/settings', () => ({
  getSecret: (key: string) => mockGetSecret(key),
}))

function fakeResponse(status: number, body = '', contentType = 'application/json'): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  } as unknown as Response
}

describe('cissGet -- retry/backoff (FASE C §11)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockGetSecret.mockReset()
    mockGetSecret.mockResolvedValue('fake-token')
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('sem token configurado: lanca CissPermanentError sem nenhuma chamada de rede', async () => {
    mockGetSecret.mockResolvedValue(null)
    const { cissGet, CissPermanentError } = await import('./client')

    await expect(cissGet('/products/stock')).rejects.toThrow(CissPermanentError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('erro permanente (404): lanca imediatamente, uma unica tentativa', async () => {
    const { cissGet, CissPermanentError } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(404, JSON.stringify({ error: 'nao encontrado' })))

    await expect(cissGet('/products/stock')).rejects.toThrow(CissPermanentError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('erro transiente (500) seguido de sucesso: uma retentativa, resultado correto', async () => {
    const { cissGet } = await import('./client')
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeResponse(500, 'erro interno do SIGAS'))
      .mockResolvedValueOnce(fakeResponse(200, JSON.stringify({ ok: true })))

    const promise = cissGet<{ ok: boolean }>('/products/stock')
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('429 (throttle) persistente: esgota MAX_RETRIES=3 tentativas e lanca CissTransientError', async () => {
    const { cissGet, CissTransientError } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(429, 'rate limited'))

    const promise = cissGet('/products/stock')
    const assertion = expect(promise).rejects.toThrow(CissTransientError)
    await vi.runAllTimersAsync()
    await assertion

    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('timeout (AbortError) persistente: esgota MAX_RETRIES=3 tentativas e lanca CissTransientError', async () => {
    const { cissGet, CissTransientError } = await import('./client')
    vi.mocked(fetch).mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'))

    const promise = cissGet('/products/stock')
    const assertion = expect(promise).rejects.toThrow(CissTransientError)
    await vi.runAllTimersAsync()
    await assertion

    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('timeout seguido de sucesso: retentativa apos AbortError funciona', async () => {
    const { cissGet } = await import('./client')
    vi.mocked(fetch)
      .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))
      .mockResolvedValueOnce(fakeResponse(200, JSON.stringify({ ok: true })))

    const promise = cissGet<{ ok: boolean }>('/products/stock')
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('erro de rede generico (nao AbortError): tambem e retentado ate MAX_RETRIES', async () => {
    const { cissGet } = await import('./client')
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(fakeResponse(200, JSON.stringify({ ok: true })))

    const promise = cissGet<{ ok: boolean }>('/products/stock')
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toEqual({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
