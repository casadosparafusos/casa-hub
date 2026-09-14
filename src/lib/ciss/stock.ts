import 'server-only'
import { cissGet, CissTransientError } from './client'

// Leitura de estoque real no CISS, via GET /products/stock -- endpoint
// DEDICADO ao Casa Hub, gerado pelo SIGAS em 03/09/2026 (token proprio,
// nao o token generico usado pela Reposicao/outros apps). Diferente do
// antigo /products/stock-sales (usado ate aqui, ver historico do arquivo):
// nao exige janela de data, e restrito a produtos com linha em
// ESTOQUE_SALDO_ATUAL (mesmo que zero/negativo).
//
//   GET /products/stock?product_id={id}&page=&per_page=
//   200 OK -> {
//     data: [{
//       product_id, description, unit, reference,
//       companies: [{ enterprise_id, stocks: [{ location_id, quantity }] }]
//     }],
//     pagination: { ... }
//   }
//   400 -> { error: "..." } (erro de validacao)
//
// ESTRATEGIA: este app so administra uma whitelist pequena (fixadores/
// parafusos), nao o catalogo inteiro -- consultamos POR PRODUTO
// (product_id como filtro), mesma logica de concorrencia limitada de antes.

export interface CissStockRow {
  productId: string
  stock: number
  /** true = o CISS respondeu OK mas sem nenhuma linha pro produto (nunca teve saldo registrado) -- tratado como 0 */
  noRecord?: boolean
  /** UNIT crua do CISS (ex: "CT", "PC", "KG"). Nunca normalizada aqui -- ver src/lib/units. */
  unitRaw?: string | null
}

interface StockCompany {
  enterprise_id: number
  stocks?: Array<{ location_id: number; quantity?: number | null }>
}

interface StockApiItem {
  product_id: number
  description?: string | null
  unit?: string | null
  reference?: string | null
  companies?: StockCompany[]
}

interface StockApiResponse {
  data: StockApiItem[]
  pagination?: unknown
}

const CONCURRENCY = 5

async function fetchOneProductStock(
  cissProductId: string,
  opts: { enterprise: number; location: number },
): Promise<CissStockRow> {
  const res = await cissGet<StockApiResponse>('/products/stock', {
    params: { product_id: cissProductId },
  })

  // Resposta sem `data` em array = formato inesperado, NUNCA "estoque zero" --
  // lanca e derruba a run inteira, pra uma resposta quebrada do SIGAS nao
  // zerar o estoque do site.
  if (!Array.isArray(res?.data)) {
    throw new CissTransientError(`CISS /products/stock sem 'data' valido para product_id=${cissProductId}`)
  }

  const item = res.data.find((r) => String(r.product_id) === cissProductId)
  // MUDANCA (10/09/2026): antes devolvia undefined e o motor registrava
  // 'failed' ("Sem leitura de estoque CISS") toda run, pra sempre. Mas o
  // endpoint so lista produtos com linha em ESTOQUE_SALDO_ATUAL -- resposta
  // 200 com data:[] (confirmado ao vivo pra 1273, 28875, 28899, que o
  // usuario confirmou estarem com 0 no ERP) significa "nunca teve saldo",
  // ou seja, zero. Erro de rede/5xx/timeout NAO chega aqui: cissGet lanca e
  // a run inteira falha, entao isto nunca zera estoque por queda do CISS.
  if (!item) return { productId: cissProductId, stock: 0, noRecord: true, unitRaw: null }

  const company = item.companies?.find((c) => c.enterprise_id === opts.enterprise)
  // Empresa/local ausente na resposta = zero legitimo (produto existe mas
  // nao tem estoque cadastrado nesse local), NUNCA descartado -- mesma regra
  // ja documentada e validada em producao pela Reposicao.
  const stock = company?.stocks?.find((s) => s.location_id === opts.location)
  const quantity = stock?.quantity
  return {
    productId: cissProductId,
    stock: quantity != null && Number.isFinite(quantity) ? quantity : 0,
    unitRaw: item.unit ?? null,
  }
}

export async function fetchStockForProducts(
  cissProductIds: string[],
  opts: { enterprise: number; location: number },
): Promise<CissStockRow[]> {
  if (cissProductIds.length === 0) return []

  const results: CissStockRow[] = []
  const queue = [...cissProductIds]

  async function worker() {
    while (queue.length > 0) {
      const id = queue.shift()
      if (id === undefined) return
      results.push(await fetchOneProductStock(id, opts))
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, cissProductIds.length) }, () => worker()))
  return results
}
