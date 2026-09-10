import { getWakePhysicalStores, getWakePriceTables, getWakePromotions } from '../src/lib/wake/client'

// Descoberta read-only dos IDs pendentes em Configuracoes (WAKE_CD_ID,
// WAKE_PRICE_TABLE_ID, WAKE_PROMOTION_ID) -- pedido do usuario (04/09/2026):
// o admin do Wake so mostra o lojaId na URL da tela de Lojas Físicas
// (ex. ?lojaId=4), nunca o centroDistribuicaoId nem os ids de tabela de
// preco/promocao. So GET, nada escreve no Wake.
//
// Rodar no servidor com o .env real carregado (o token nao existe local):
//   set -a; source .env; set +a; npx tsx --conditions=react-server scripts/wake-discover-ids.ts

async function main() {
  console.log('=== Lojas físicas / Centros de Distribuição (GET /lojasFisicas) ===')
  const stores = await getWakePhysicalStores()
  for (const s of stores) {
    console.log(`  lojaId=${s.lojaId}  centroDistribuicaoId=${s.centroDistribuicaoId}  nome="${s.nome}"  ativo=${s.ativo}`)
  }

  console.log('\n=== Tabelas de preço (GET /tabelaPrecos) ===')
  const tables = await getWakePriceTables()
  for (const t of tables) {
    console.log(`  tabelaPrecoId=${t.tabelaPrecoId}  nome="${t.nome}"  ativo=${t.ativo}  isSite=${t.isSite}`)
  }

  console.log('\n=== Promoções (GET /promocoes -- path inferido, ver aviso se falhar) ===')
  try {
    const promos = await getWakePromotions()
    for (const p of promos) {
      console.log(`  promocaoId=${p.promocaoId}  nome="${p.nome}"  ativo=${p.ativo}`)
    }
  } catch (err) {
    console.error('  Falha ao consultar /promocoes -- path pode estar errado (não confirmado na doc pública):')
    console.error('  ', err instanceof Error ? err.message : err)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
