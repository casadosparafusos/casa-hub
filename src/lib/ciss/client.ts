import 'server-only'
import { getSecret } from '@/lib/settings'

// Cliente HTTP baixo-nivel pro ERP CISS/PODER -- mesma base da Reposicao
// (ver /opt/reposicao/docs/ciss-required-endpoints.md), mas isolado aqui
// porque este projeto tem seu proprio banco/servico e nao deve importar
// codigo do app da Reposicao.
//
// So GET (leitura). Esta integracao nunca escreve no CISS.

export class CissClientError extends Error {}
export class CissTransientError extends CissClientError {} // timeout, 5xx, rede -- retry cabivel
export class CissPermanentError extends CissClientError {} // 400/401/403/404 -- nao adianta repetir

// Mesma base real que a Reposicao usa em producao (confirmada, nao
// placeholder -- ver Reposição de Estoque/.env.example e README.md).
const CISS_BASE_URL = process.env.CISS_BASE_URL ?? 'http://sigas.casadosparafusos.com:5099/api/ciss'
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_RETRIES = 3

interface CissRequestOptions {
  params?: Record<string, string | number | undefined>
  timeoutMs?: number
}

/**
 * Alguns endpoints do CISS respondem em latin-1 (ver
 * [[aba-produtos-by-product-erp]]) -- decodificamos via ArrayBuffer quando
 * o content-type nao e claramente utf-8/json, pra nao corromper acentos.
 */
async function decodeBody(res: Response): Promise<string> {
  const contentType = res.headers.get('content-type') ?? ''
  const buf = await res.arrayBuffer()
  if (contentType.includes('charset=iso-8859-1') || contentType.includes('charset=latin1')) {
    return new TextDecoder('iso-8859-1').decode(buf)
  }
  return new TextDecoder('utf-8').decode(buf)
}

export async function cissGet<T>(path: string, options: CissRequestOptions = {}): Promise<T> {
  const token = await getSecret('CISS_API_TOKEN')
  if (!token) {
    throw new CissPermanentError('CISS_API_TOKEN nao configurado (tela de Configuracoes ou .env)')
  }

  // NAO usar `new URL(path, CISS_BASE_URL)` -- CISS_BASE_URL ja tem um path
  // proprio (".../api/ciss") e todo `path` passado aqui comeca com "/", e
  // pela spec do WHATWG URL uma referencia relativa com "/" descarta o path
  // inteiro da base e resolve so contra a origem, derrubando o "/api/ciss" e
  // caindo no site institucional do SIGAS (que devolve 404 HTML propria em
  // vez do erro real da API CISS). Bug encontrado e corrigido em 08/09/2026
  // -- concatenacao de string simples, sem depender da resolucao relativa.
  const url = new URL(CISS_BASE_URL.replace(/\/+$/, '') + path)
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }

  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (res.status === 429 || res.status >= 500) {
        // Mesmo raciocinio do corpo no erro permanente logo abaixo -- um 500
        // do SIGAS costuma vir com stacktrace/mensagem util pra distinguir
        // bug pontual de timeout puro.
        const body = await decodeBody(res).catch(() => '')
        lastError = new CissTransientError(`CISS ${res.status} em ${path} (tentativa ${attempt}/${MAX_RETRIES})${body ? `: ${body.slice(0, 300)}` : ''}`)
        await backoff(attempt)
        continue
      }
      if (!res.ok) {
        // Inclui o corpo da resposta na mensagem -- o SIGAS costuma devolver
        // {"error": "..."} com o motivo real (ex: escopo faltando, token
        // invalido), que antes era descartado e so sobrava o status cru,
        // dificultando diagnostico de 401/403 (ver 401 em /products/prices
        // investigado em 08/09/2026).
        const body = await decodeBody(res).catch(() => '')
        throw new CissPermanentError(`CISS ${res.status} em ${path}${body ? `: ${body.slice(0, 300)}` : ''}`)
      }

      const text = await decodeBody(res)
      return JSON.parse(text) as T
    } catch (err) {
      clearTimeout(timeout)
      if (err instanceof CissPermanentError) throw err
      if (err instanceof DOMException && err.name === 'AbortError') {
        lastError = new CissTransientError(`CISS timeout em ${path} (tentativa ${attempt}/${MAX_RETRIES})`)
        await backoff(attempt)
        continue
      }
      lastError = err
      await backoff(attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new CissTransientError(`Falha desconhecida em ${path}`)
}

function backoff(attempt: number): Promise<void> {
  const ms = Math.min(1000 * 2 ** (attempt - 1), 8000)
  return new Promise((resolve) => setTimeout(resolve, ms))
}
