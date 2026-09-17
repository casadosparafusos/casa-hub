import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// FASE C §11: wake/client.ts nao tinha nenhum teste dedicado -- so cobertura
// indireta via engine.test.ts, que mocka '../wake/client' inteiro e nunca
// exercita wakeRequest()/o circuito de throttle de verdade. Este arquivo
// prova: retry conservador (MAX_RETRIES=2), backoff de 429 respeitando
// Retry-After, backoff fixo de 5xx, erro permanente sem retry, e o circuito
// que abre apos 5 throttles consecutivos (ver comentario no topo de
// src/lib/wake/client.ts -- 5 respostas 429 seguidas travam o token por 1h).

vi.mock('server-only', () => ({}))

const mockGetSecret = vi.fn<(key: string) => Promise<string | null>>()
vi.mock('@/lib/settings', () => ({
  getSecret: (key: string) => mockGetSecret(key),
}))

function fakeResponse(status: number, body = '', headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null },
    text: async () => body,
  } as unknown as Response
}

describe('wakeRequest -- retry/backoff/circuito (FASE C §11)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    mockGetSecret.mockReset()
    mockGetSecret.mockResolvedValue('fake-token')
    vi.stubGlobal('fetch', vi.fn())
    // consecutiveThrottles e estado de modulo (por design -- ver comentario
    // em wake/client.ts) e nao tem reset exportado, entao cada suite de
    // teste precisa reimportar o modulo do zero pra zerar o contador.
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('sem token configurado: lanca WakePermanentError sem nenhuma chamada de rede', async () => {
    mockGetSecret.mockResolvedValue(null)
    const { getWakeProductBySku, WakePermanentError } = await import('./client')

    await expect(getWakeProductBySku('1234')).rejects.toThrow(WakePermanentError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('erro permanente (403): lanca imediatamente, uma unica tentativa', async () => {
    const { getWakePriceTables, WakePermanentError } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(403, 'sem permissao'))

    await expect(getWakePriceTables()).rejects.toThrow(WakePermanentError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('500 seguido de sucesso: uma retentativa (MAX_RETRIES=2), resultado correto', async () => {
    const { getWakePriceTables } = await import('./client')
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeResponse(500, 'erro interno'))
      .mockResolvedValueOnce(fakeResponse(200, JSON.stringify([{ tabelaPrecoId: 74, nome: 'Padrao', ativo: true, isSite: true }])))

    const promise = getWakePriceTables()
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toEqual([{ tabelaPrecoId: 74, nome: 'Padrao', ativo: true, isSite: true }])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('500 persistente: esgota MAX_RETRIES=2 tentativas e lanca WakeTransientError', async () => {
    const { getWakePriceTables, WakeTransientError } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(500, 'erro interno'))

    const promise = getWakePriceTables()
    const assertion = expect(promise).rejects.toThrow(WakeTransientError)
    await vi.runAllTimersAsync()
    await assertion

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('429 respeita Retry-After antes de tentar de novo', async () => {
    const { getWakePriceTables } = await import('./client')
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeResponse(429, 'throttle', { 'Retry-After': '7' }))
      .mockResolvedValueOnce(fakeResponse(200, JSON.stringify([])))

    const promise = getWakePriceTables()

    // avanca so 6.9s -- backoff de 7s ainda nao deve ter disparado a 2a tentativa
    await vi.advanceTimersByTimeAsync(6900)
    expect(fetch).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(200)
    const result = await promise

    expect(result).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('429 persistente esgota MAX_RETRIES=2 tentativas e lanca WakeTransientError', async () => {
    const { getWakePriceTables, WakeTransientError } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(429, 'throttle'))

    const promise = getWakePriceTables()
    const assertion = expect(promise).rejects.toThrow(WakeTransientError)
    await vi.runAllTimersAsync()
    await assertion

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('timeout (AbortError) seguido de sucesso: retentativa funciona', async () => {
    const { getWakePriceTables } = await import('./client')
    vi.mocked(fetch)
      .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))
      .mockResolvedValueOnce(fakeResponse(200, JSON.stringify([])))

    const promise = getWakePriceTables()
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('circuito abre apos 5 throttles consecutivos: recusa sem chamar fetch, mesmo em rota nova', async () => {
    const { getWakePriceTables, getWakePhysicalStores, WakeTransientError, WakePermanentError } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(429, 'throttle'))

    // 3 execucoes de getWakePriceTables() (MAX_RETRIES=2 cada) = 6 tentativas
    // de 429 -- mais que suficiente pra passar do limiar de 5 consecutivos.
    for (let i = 0; i < 3; i++) {
      const promise = getWakePriceTables()
      const assertion = expect(promise).rejects.toThrow(WakeTransientError)
      await vi.runAllTimersAsync()
      await assertion
    }

    vi.mocked(fetch).mockClear()
    // proxima chamada, em endpoint diferente, deve recusar de cara (circuito
    // aberto e estado de modulo global, nao por endpoint).
    await expect(getWakePhysicalStores()).rejects.toThrow(WakePermanentError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('getWakeProductBySku: 422 (produto nao encontrado) devolve null, sem retry', async () => {
    const { getWakeProductBySku } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(422, 'Produto nao encontrado'))

    const result = await getWakeProductBySku('sku-inexistente')

    expect(result).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

// FASE C.1 §2/§3: readWakeStockByVariantId() e o novo adaptador READ-ONLY
// que finalmente permite reconferir estoque por releitura (GET /produtos,
// endpoint de listagem/catalogo, nao o de item unico usado por
// getWakeProductBySku -- ver comentario em src/lib/wake/client.ts). Estes
// testes provam a query certa (cursor exclusivo produtoVarianteIdDe =
// variantId-1) e cada caso de "nao verificavel" -> null, nunca aceitando
// silenciosamente um produto de um gap de ID.
describe('readWakeStockByVariantId (FASE C.1 §2/§3)', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    mockGetSecret.mockReset()
    mockGetSecret.mockResolvedValue('fake-token')
    vi.stubGlobal('fetch', vi.fn())
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('monta a query com cursor exclusivo (variantId-1) e os params certos', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(
      fakeResponse(200, JSON.stringify([{ produtoVarianteId: 281145, estoque: [{ centroDistribuicaoId: 25, estoqueFisico: 42 }] }])),
    )

    const result = await readWakeStockByVariantId(281145, 25)

    expect(result).toBe(42)
    const calledUrl = new URL(vi.mocked(fetch).mock.calls[0]![0] as string)
    expect(calledUrl.pathname).toBe('/produtos')
    expect(calledUrl.searchParams.get('produtoVarianteIdDe')).toBe('281144')
    expect(calledUrl.searchParams.get('quantidadeRegistros')).toBe('1')
    expect(calledUrl.searchParams.get('camposAdicionais')).toBe('Estoque')
    expect(calledUrl.searchParams.get('centrosDistribuicao')).toBe('25')
  })

  it('resposta vazia (produto nao encontrado nessa posicao de cursor): devolve null', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(200, JSON.stringify([])))

    expect(await readWakeStockByVariantId(281145, 25)).toBeNull()
  })

  it('item devolvido com produtoVarianteId diferente do pedido (gap de ID): devolve null, nunca aceita outro produto', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(
      fakeResponse(200, JSON.stringify([{ produtoVarianteId: 281146, estoque: [{ centroDistribuicaoId: 25, estoqueFisico: 99 }] }])),
    )

    expect(await readWakeStockByVariantId(281145, 25)).toBeNull()
  })

  it('campo estoque ausente na resposta: devolve null', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(200, JSON.stringify([{ produtoVarianteId: 281145 }])))

    expect(await readWakeStockByVariantId(281145, 25)).toBeNull()
  })

  it('estoque[] presente mas sem entrada pro centro de distribuicao pedido: devolve null', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(
      fakeResponse(200, JSON.stringify([{ produtoVarianteId: 281145, estoque: [{ centroDistribuicaoId: 99, estoqueFisico: 42 }] }])),
    )

    expect(await readWakeStockByVariantId(281145, 25)).toBeNull()
  })

  it('estoqueFisico nao-numerico: devolve null', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(
      fakeResponse(200, JSON.stringify([{ produtoVarianteId: 281145, estoque: [{ centroDistribuicaoId: 25, estoqueFisico: null }] }])),
    )

    expect(await readWakeStockByVariantId(281145, 25)).toBeNull()
  })

  it('erro de rede/protocolo propaga (chamador trata como FAILED, nao como null/MISMATCH)', async () => {
    const { readWakeStockByVariantId, WakeTransientError } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(500, 'erro interno'))

    const promise = readWakeStockByVariantId(281145, 25)
    const assertion = expect(promise).rejects.toThrow(WakeTransientError)
    await vi.runAllTimersAsync()
    await assertion
  })
})
