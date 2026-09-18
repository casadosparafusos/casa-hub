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

  // FASE D-PRE §6 (achado independente do Tech Lead): fetch() rejeita com
  // TypeError (nao AbortError) numa falha de rede REAL -- DNS, conexao
  // recusada, socket caindo no meio. Antes disso, esse catch reconhecia so
  // WakeClientError (repropaga) e AbortError (retry) -- um TypeError
  // generico caia no `throw err` final, subindo sem NENHUMA tentativa nova,
  // mesmo sendo o tipo de falha mais obvio pra retentar.
  it('falha de rede (TypeError) seguida de sucesso: retentativa funciona', async () => {
    const { getWakePriceTables } = await import('./client')
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(fakeResponse(200, JSON.stringify([])))

    const promise = getWakePriceTables()
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toEqual([])
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('falha de rede (TypeError) persistente: esgota MAX_RETRIES=2 tentativas e lanca WakeTransientError', async () => {
    const { getWakePriceTables, WakeTransientError } = await import('./client')
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'))

    const promise = getWakePriceTables()
    const assertion = expect(promise).rejects.toThrow(WakeTransientError)
    await vi.runAllTimersAsync()
    await assertion

    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('erro permanente (4xx) nunca retenta, mesmo quando pareceria uma falha transiente', async () => {
    const { getWakePriceTables, WakePermanentError } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(401, 'nao autorizado'))

    await expect(getWakePriceTables()).rejects.toThrow(WakePermanentError)
    expect(fetch).toHaveBeenCalledTimes(1)
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

// FASE C.2 §2/§3/§4/§6: readWakeStockByVariantId() passou a usar o endpoint
// OFICIAL DEDICADO de estoque (GET /produtos/{identificador}/estoque,
// tipoIdentificador=ProdutoVarianteId) em vez do endpoint de listagem
// (GET /produtos + cursor produtoVarianteIdDe) usado na FASE C.1 -- ver
// docs/WAKE-API-CONTRATOS.md pro historico e comentario em
// src/lib/wake/client.ts pra fonte da confirmacao do schema de resposta.
// Estes testes cobrem os cenarios minimos A-H exigidos pela FASE C.2 §6.
describe('readWakeStockByVariantId (FASE C.2 §2/§3/§4/§6 -- endpoint oficial dedicado)', () => {
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

  function stockResponse(overrides: {
    estoqueFisico?: number
    estoqueReservado?: number
    cds?: Array<{ centroDistribuicaoId: number; nome?: string; estoqueFisico?: unknown; estoqueReservado?: number }>
  } = {}): string {
    return JSON.stringify({
      estoqueFisico: overrides.estoqueFisico ?? 0,
      estoqueReservado: overrides.estoqueReservado ?? 0,
      listProdutoVarianteCentroDistribuicaoEstoque: overrides.cds ?? [],
    })
  }

  it('A. monta a query certa: GET /produtos/{variantId}/estoque, tipoIdentificador=ProdutoVarianteId', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(200, stockResponse({ cds: [{ centroDistribuicaoId: 25, estoqueFisico: 42 }] })))

    const result = await readWakeStockByVariantId(281145, 25)

    expect(result).toBe(42)
    const calledUrl = new URL(vi.mocked(fetch).mock.calls[0]![0] as string)
    expect(calledUrl.pathname).toBe('/produtos/281145/estoque')
    expect(calledUrl.searchParams.get('tipoIdentificador')).toBe('ProdutoVarianteId')
  })

  it('B. resposta com o CD esperado: devolve o estoqueFisico da entrada correta', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(
      fakeResponse(200, stockResponse({ estoqueFisico: 42, cds: [{ centroDistribuicaoId: 25, nome: 'CD Principal', estoqueFisico: 42 }] })),
    )

    expect(await readWakeStockByVariantId(281145, 25)).toBe(42)
  })

  it('C. multiplos CDs na resposta: escolhe somente a entrada do cdId esperado, ignora as outras', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(
      fakeResponse(
        200,
        stockResponse({
          estoqueFisico: 142,
          cds: [
            { centroDistribuicaoId: 10, estoqueFisico: 100 },
            { centroDistribuicaoId: 25, estoqueFisico: 42 },
          ],
        }),
      ),
    )

    expect(await readWakeStockByVariantId(281145, 25)).toBe(42)
  })

  it('D. CD esperado ausente na lista: devolve null -- nunca usa o total agregado do topo, nunca 0 silencioso', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(
      fakeResponse(200, stockResponse({ estoqueFisico: 100, cds: [{ centroDistribuicaoId: 99, estoqueFisico: 100 }] })),
    )

    expect(await readWakeStockByVariantId(281145, 25)).toBeNull()
  })

  it('E. 404 (produto nao encontrado): devolve null, uma unica tentativa, sem retry indevido', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(404, 'Produto nao encontrado'))

    expect(await readWakeStockByVariantId(281145, 25)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('F. 429 (throttle): respeita a politica de retry/backoff existente e confirma o valor apos a retentativa', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeResponse(429, 'throttle', { 'Retry-After': '5' }))
      .mockResolvedValueOnce(fakeResponse(200, stockResponse({ cds: [{ centroDistribuicaoId: 25, estoqueFisico: 42 }] })))

    const promise = readWakeStockByVariantId(281145, 25)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toBe(42)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('G. 5xx: respeita a politica de retry existente e confirma o valor apos a retentativa', async () => {
    const { readWakeStockByVariantId } = await import('./client')
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeResponse(500, 'erro interno'))
      .mockResolvedValueOnce(fakeResponse(200, stockResponse({ cds: [{ centroDistribuicaoId: 25, estoqueFisico: 42 }] })))

    const promise = readWakeStockByVariantId(281145, 25)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toBe(42)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('G2. 5xx/rede persistente (retries esgotados): propaga (chamador trata como FAILED, nao null/MISMATCH)', async () => {
    const { readWakeStockByVariantId, WakeTransientError } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(500, 'erro interno'))

    const promise = readWakeStockByVariantId(281145, 25)
    const assertion = expect(promise).rejects.toThrow(WakeTransientError)
    await vi.runAllTimersAsync()
    await assertion
  })

  it('H. campo estoque malformado (lista ausente / entrada sem estoqueFisico / tipo nao-numerico): fail-closed em todos os casos', async () => {
    const { readWakeStockByVariantId } = await import('./client')

    vi.mocked(fetch).mockResolvedValueOnce(fakeResponse(200, JSON.stringify({ estoqueFisico: 10, estoqueReservado: 0 })))
    expect(await readWakeStockByVariantId(281145, 25)).toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(fakeResponse(200, stockResponse({ cds: [{ centroDistribuicaoId: 25 }] })))
    expect(await readWakeStockByVariantId(281145, 25)).toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(fakeResponse(200, stockResponse({ cds: [{ centroDistribuicaoId: 25, estoqueFisico: '42' }] })))
    expect(await readWakeStockByVariantId(281145, 25)).toBeNull()
  })
})

// revisao Tech Lead PR #4, revisao final #2, item 3: readWakePriceTableByVariantId()
// nao tinha teste direto -- engine.test.ts so mocka '../wake/client' e nunca
// exercitava URL/query real, selecao estrita de tableId, payload malformado ou o
// retry herdado de wakeRequest(). Suite mirror de readWakeStockByVariantId acima,
// mesma estrutura A-H do documento de revisao.
describe('readWakePriceTableByVariantId (revisao Tech Lead PR #4, revisao final #2, item 3)', () => {
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

  function priceTableResponse(tabelasPreco: Array<{ tabelaPrecoId: number; precoDe?: unknown; precoPor?: unknown }> | undefined): string {
    return JSON.stringify(tabelasPreco === undefined ? {} : { tabelasPreco })
  }

  it('A. monta a query certa: GET /produtos/{variantId}, tipoIdentificador=ProdutoVarianteId, camposAdicionais=TabelaPreco', async () => {
    const { readWakePriceTableByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(200, priceTableResponse([{ tabelaPrecoId: 74, precoDe: 10, precoPor: 7.5 }])))

    const result = await readWakePriceTableByVariantId(281145, 74)

    expect(result).toEqual({ precoDe: 10, precoPor: 7.5 })
    const calledUrl = new URL(vi.mocked(fetch).mock.calls[0]![0] as string)
    expect(calledUrl.pathname).toBe('/produtos/281145')
    expect(calledUrl.searchParams.get('tipoIdentificador')).toBe('ProdutoVarianteId')
    expect(calledUrl.searchParams.get('camposAdicionais')).toBe('TabelaPreco')
  })

  it('B. tabelasPreco com multiplas entradas: devolve somente a do tableId alvo, ignora as outras', async () => {
    const { readWakePriceTableByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(
      fakeResponse(
        200,
        priceTableResponse([
          { tabelaPrecoId: 10, precoDe: 99, precoPor: 88 },
          { tabelaPrecoId: 74, precoDe: 10, precoPor: 7.5 },
        ]),
      ),
    )

    expect(await readWakePriceTableByVariantId(281145, 74)).toEqual({ precoDe: 10, precoPor: 7.5 })
  })

  it('C. tableId alvo ausente na lista: devolve null', async () => {
    const { readWakePriceTableByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(200, priceTableResponse([{ tabelaPrecoId: 99, precoDe: 10, precoPor: 7.5 }])))

    expect(await readWakePriceTableByVariantId(281145, 74)).toBeNull()
  })

  it('D. tabelasPreco ausente ou nao-array: devolve null', async () => {
    const { readWakePriceTableByVariantId } = await import('./client')

    vi.mocked(fetch).mockResolvedValueOnce(fakeResponse(200, priceTableResponse(undefined)))
    expect(await readWakePriceTableByVariantId(281145, 74)).toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(fakeResponse(200, JSON.stringify({ tabelasPreco: 'nao-e-array' })))
    expect(await readWakePriceTableByVariantId(281145, 74)).toBeNull()
  })

  it('E. precoDe/precoPor ausente, nao-numerico ou non-finite: fail-closed em todos os casos', async () => {
    const { readWakePriceTableByVariantId } = await import('./client')

    vi.mocked(fetch).mockResolvedValueOnce(fakeResponse(200, priceTableResponse([{ tabelaPrecoId: 74 }])))
    expect(await readWakePriceTableByVariantId(281145, 74)).toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(fakeResponse(200, priceTableResponse([{ tabelaPrecoId: 74, precoDe: '10', precoPor: 7.5 }])))
    expect(await readWakePriceTableByVariantId(281145, 74)).toBeNull()

    vi.mocked(fetch).mockResolvedValueOnce(fakeResponse(200, priceTableResponse([{ tabelaPrecoId: 74, precoDe: 10, precoPor: Number.POSITIVE_INFINITY }])))
    expect(await readWakePriceTableByVariantId(281145, 74)).toBeNull()
  })

  it('F. 404 (produto nao encontrado): devolve null, uma unica tentativa, sem retry indevido', async () => {
    const { readWakePriceTableByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(404, 'Produto nao encontrado'))

    expect(await readWakePriceTableByVariantId(281145, 74)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('G. 422 (produto nao encontrado): devolve null, consistente com getWakeProductBySku no mesmo endpoint', async () => {
    const { readWakePriceTableByVariantId } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(422, 'Produto nao encontrado'))

    expect(await readWakePriceTableByVariantId(281145, 74)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('H1. 429/5xx/TypeError transientes: usa a politica central de retry e confirma o valor apos a retentativa', async () => {
    const { readWakePriceTableByVariantId } = await import('./client')
    vi.mocked(fetch)
      .mockResolvedValueOnce(fakeResponse(429, 'throttle', { 'Retry-After': '5' }))
      .mockResolvedValueOnce(fakeResponse(200, priceTableResponse([{ tabelaPrecoId: 74, precoDe: 10, precoPor: 7.5 }])))

    const promise = readWakePriceTableByVariantId(281145, 74)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result).toEqual({ precoDe: 10, precoPor: 7.5 })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('H2. 5xx/rede persistente (retries esgotados): propaga (chamador/engine trata como FAILED, nao null)', async () => {
    const { readWakePriceTableByVariantId, WakeTransientError } = await import('./client')
    vi.mocked(fetch).mockResolvedValue(fakeResponse(500, 'erro interno'))

    const promise = readWakePriceTableByVariantId(281145, 74)
    const assertion = expect(promise).rejects.toThrow(WakeTransientError)
    await vi.runAllTimersAsync()
    await assertion
  })
})
