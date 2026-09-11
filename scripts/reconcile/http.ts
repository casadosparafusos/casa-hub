// UNICO ponto de saida HTTP do reconciliador. So existe GET: o metodo e
// fixo aqui dentro, nao ha parametro de metodo nem de corpo. Qualquer outro
// verbo neste diretorio e barrado pelo teste estatico (no-write-path.test.ts).

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

export interface GetResult {
  status: number
  headers: Headers
  body: string
}

/** Decodifica pelo charset do content-type (o CISS as vezes responde em latin-1). */
export async function decodeBody(res: Response): Promise<string> {
  const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
  const buf = await res.arrayBuffer()
  if (contentType.includes('charset=iso-8859-1') || contentType.includes('charset=latin1')) {
    return new TextDecoder('iso-8859-1').decode(buf)
  }
  return new TextDecoder('utf-8').decode(buf)
}

export async function readOnlyGet(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<GetResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    const body = await decodeBody(res)
    return { status: res.status, headers: res.headers, body }
  } finally {
    clearTimeout(timer)
  }
}

/** Monta URL por concatenacao (NAO usar new URL(path, base): derruba o path da base). */
export function buildUrl(base: string, path: string, params: Record<string, string | number | undefined> = {}): string {
  const url = new URL(base.replace(/\/+$/, '') + path)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }
  return url.toString()
}

/** Path + query, sem host -- para log. Nenhuma query deste script leva segredo (auth vai so em header). */
export function pathOnly(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname + (u.search ? u.search : '')
  } catch {
    return '<url invalida>'
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
