import 'server-only'
import { searchProductPrices } from './prices'

// -----------------------------------------------------------------------
// RESOLVIDO em 03/09/2026: o SIGAS confirmou GET /products/prices/search
// (endpoint dedicado ao Casa Hub, token proprio -- ver src/lib/ciss/prices.ts
// e docs/PEDIDO-CISS-PRECO.md, agora marcado resolvido). Ate aqui nenhum
// endpoint/campo do CISS expunha preco de varejo (mesmo padrao de bloqueio
// documentado em [[erp-ciss-sem-flag-ativo-inativo-sku]] pra outro campo).
//
// Troca via env var CISS_PRICE_PROVIDER=mock|live (default mock, mas o
// deploy do Casa Hub ja roda 'live' desde que o token dedicado foi
// instalado -- ver .env no servidor).
// -----------------------------------------------------------------------

export interface PriceProvider {
  readonly name: 'mock' | 'live'
  getRetailPrices(cissProductIds: string[]): Promise<Map<string, number>>
}

/**
 * Provider mock -- gera um preco deterministico (mas claramente fake) a
 * partir do id do produto, so pra permitir testar o motor de preco e o
 * fluxo de sync ponta-a-ponta (inclusive dry-run) antes do campo real
 * existir. Nunca deve rodar contra o Wake fora de dry-run.
 */
export const mockPriceProvider: PriceProvider = {
  name: 'mock',
  async getRetailPrices(cissProductIds) {
    const map = new Map<string, number>()
    for (const id of cissProductIds) {
      // hash simples e estavel so pra variar o preco mock por produto
      let hash = 0
      for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 100000
      const price = 5 + (hash % 4500) / 100 // entre R$5,00 e R$49,99 aprox.
      map.set(id, Math.round(price * 100) / 100)
    }
    return map
  },
}

/**
 * Provider real -- via GET /products/prices/search (src/lib/ciss/prices.ts),
 * batendo por product_ids em lotes. Produtos com retail_price=null (sem
 * historico de custo valido no CISS) sao OMITIDOS do Map de proposito --
 * syncPrices() (src/lib/sync/engine.ts) registra esses ids como item
 * 'skipped' (Ignorado, "sem preco cadastrado no ERP") -- nao e erro.
 */
export const livePriceProvider: PriceProvider = {
  name: 'live',
  async getRetailPrices(cissProductIds) {
    const prices = await searchProductPrices({ productIds: cissProductIds })
    const map = new Map<string, number>()
    for (const p of prices) {
      if (p.retailPrice != null) map.set(p.productId, p.retailPrice)
    }
    return map
  },
}

export function getActivePriceProvider(): PriceProvider {
  const mode = process.env.CISS_PRICE_PROVIDER ?? 'mock'
  if (mode === 'live') return livePriceProvider
  return mockPriceProvider
}
