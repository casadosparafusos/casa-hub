import { getWakeProductBySku } from '../src/lib/wake/client'

// Diagnostico read-only: consulta o produto direto no Wake pra ver o que
// a API realmente tem gravado (stock/listaEstoque/ativo/etc), sem passar
// pelo nosso banco -- pra descobrir se o PUT /produtos/estoques do
// syncRunId=172 realmente aplicou no Wake ou se falhou silenciosamente
// (updateWakeStock() em src/lib/wake/client.ts ignora o corpo da resposta).

async function main() {
  const sku = process.argv[2]
  if (!sku) throw new Error('uso: tsx check-wake-stock.ts <sku>')
  const product = await getWakeProductBySku(sku)
  console.log(JSON.stringify(product, null, 2))
}

main().catch((err) => {
  console.error('ERRO:', err)
  process.exit(1)
})
