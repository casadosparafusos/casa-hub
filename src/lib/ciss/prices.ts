import 'server-only'
import { cissGet } from './client'

// Leitura de preco de varejo real no CISS -- endpoints DEDICADOS ao Casa Hub,
// gerados pelo SIGAS em 03/09/2026 (token proprio), que resolvem o bloqueio
// historicamente documentado em price-provider.ts (nenhum campo/endpoint
// do CISS expunha preco de varejo ate aqui -- ver docs/PEDIDO-CISS-PRECO.md,
// agora marcado como resolvido).
//
//   GET /products/prices/{product_id}
//   200 OK -> { product_id, description, reference, retail_price }
//     -- retail_price pode vir null (produto sem historico de custo valido
//        no CISS -- NAO e erro, e ausencia de verdade)
//   404 -> { error: "Product not found." }
//
//   GET /products/prices/search?product_ids=1,2,3&references=REF1,REF2&page=&per_page=
//     -- product_ids (IDPRODUTO) e/ou references (REFERENCIA, match exato),
//        combinados via OR; pelo menos um dos dois e obrigatorio
//   200 OK -> { data: [{ product_id, description, reference, retail_price }], pagination: {...} }
//   400 -> nenhum filtro informado
//
//   GET /products/prices?page=&per_page=
//   200 OK -> mesma forma paginada do /search, sem filtro (catalogo inteiro)
//
// Todos os tres aceitam os mesmos parametros de override (aplicam pra TODOS
// os produtos daquela chamada, nao por produto):
//   sales_icms_percentage, operational_expenses_percentage,
//   inflation_percentage, profit_margin_percentage (aceitam '.' ou ',')

export interface CissPriceOverrides {
  salesIcmsPercentage?: number
  operationalExpensesPercentage?: number
  inflationPercentage?: number
  profitMarginPercentage?: number
}

export interface CissProductPrice {
  productId: string
  description: string | null
  reference: string | null
  retailPrice: number | null
}

interface PriceApiItem {
  product_id: number
  description?: string | null
  reference?: string | null
  retail_price: number | null
}

interface PriceListApiResponse {
  data: PriceApiItem[]
  pagination?: { total_pages?: number; page?: number; [k: string]: unknown }
}

function overrideParams(overrides?: CissPriceOverrides): Record<string, string | number | undefined> {
  if (!overrides) return {}
  return {
    sales_icms_percentage: overrides.salesIcmsPercentage,
    operational_expenses_percentage: overrides.operationalExpensesPercentage,
    inflation_percentage: overrides.inflationPercentage,
    profit_margin_percentage: overrides.profitMarginPercentage,
  }
}

function toDomain(item: PriceApiItem): CissProductPrice {
  return {
    productId: String(item.product_id),
    description: item.description ?? null,
    reference: item.reference ?? null,
    retailPrice: item.retail_price,
  }
}

/** GET /products/prices/{product_id} -- um produto. null se 404 (nao encontrado). */
export async function fetchProductPrice(productId: string, overrides?: CissPriceOverrides): Promise<CissProductPrice | null> {
  try {
    const item = await cissGet<PriceApiItem>(`/products/prices/${encodeURIComponent(productId)}`, {
      params: overrideParams(overrides),
    })
    return toDomain(item)
  } catch (err) {
    // CissPermanentError generico embrulha o 404 -- ver client.ts, que nao
    // tipa por status HTTP. Sem forma melhor de distinguir 404 de outro 4xx
    // aqui sem mudar o contrato do cissGet pra todos os chamadores.
    if (err instanceof Error && /\b404\b/.test(err.message)) return null
    throw err
  }
}

const SEARCH_PAGE_SIZE = 500 // max documentado
const CHUNK_SIZE = 150 // produtos por chamada em product_ids -- evita URL gigante

async function searchOneChunk(
  params: { productIds?: string[]; references?: string[] },
  overrides?: CissPriceOverrides,
): Promise<CissProductPrice[]> {
  const out: CissProductPrice[] = []
  let page = 1
  for (;;) {
    const res = await cissGet<PriceListApiResponse>('/products/prices/search', {
      params: {
        product_ids: params.productIds?.join(','),
        references: params.references?.join(','),
        page,
        per_page: SEARCH_PAGE_SIZE,
        ...overrideParams(overrides),
      },
    })
    out.push(...(res.data ?? []).map(toDomain))
    const totalPages = res.pagination?.total_pages ?? 1
    if (page >= totalPages) break
    page++
  }
  return out
}

/** GET /products/prices/search -- por product_ids e/ou references, em lotes. */
export async function searchProductPrices(
  params: { productIds?: string[]; references?: string[] },
  overrides?: CissPriceOverrides,
): Promise<CissProductPrice[]> {
  const ids = params.productIds ?? []
  const refs = params.references ?? []
  if (ids.length === 0 && refs.length === 0) return []

  const results: CissProductPrice[] = []

  if (ids.length > 0) {
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE)
      results.push(...(await searchOneChunk({ productIds: chunk }, overrides)))
    }
  }
  if (refs.length > 0) {
    for (let i = 0; i < refs.length; i += CHUNK_SIZE) {
      const chunk = refs.slice(i, i + CHUNK_SIZE)
      results.push(...(await searchOneChunk({ references: chunk }, overrides)))
    }
  }
  return results
}
