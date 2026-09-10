import { eq } from 'drizzle-orm'
import { db, schema } from '../src/lib/db'
import { setSetting } from '../src/lib/settings'
import { runSync } from '../src/lib/sync/engine'

// Ativa em massa a whitelist de Fixadores + reativa o piloto (SKU 1563, que
// tinha sido desativado sem querer pelo import anterior -- a linha dele
// tambem veio no CSV de Fixadores com active=0, ver import-fixadores-bulk.ts)
// e dispara uma sincronizacao real (kind=both) pra levar preco+estoque pro
// Wake AGORA, em vez de esperar o proximo ciclo agendado (preco: ate 24h;
// estoque: proximo tick do worker). Autorizado pelo usuario em 08/09/2026:
// "Eu autorizo, ja pode ativar todos os produtos, e sincronizar o preco e o
// estoque."
//
// Tambem sobe STOCK_SYNC_INTERVAL_MINUTES de 1 pra 15 antes de disparar --
// a 1 produto, 1 sync de estoque por minuto era barato (1 chamada no CISS);
// a 2319 produtos, cada sync de estoque faz 1 chamada POR PRODUTO
// (fetchStockForProducts, CONCURRENCY=5, sem endpoint em lote no CISS -- ver
// src/lib/ciss/stock.ts), levando bem mais que 1 minuto pra rodar. Manter o
// intervalo em 1min faria o worker tentar de novo assim que a run anterior
// terminasse, martelando o CISS sem folga nenhuma -- risco real dado o
// historico de timeout intermitente do CISS sob carga (ver memoria
// ciss-stock-sales-timeout-intermitente-2026-09-08, endpoint irmao).

async function main() {
  const activated = await db
    .update(schema.managedProducts)
    .set({ active: true, updatedAt: new Date().toISOString() })
    .where(eq(schema.managedProducts.active, false))
    .returning({ id: schema.managedProducts.id })
  console.log(`Produtos ativados (active=0 -> 1): ${activated.length}`)

  await setSetting('STOCK_SYNC_INTERVAL_MINUTES', '15', 'claude-activate-fixadores-2026-09-08')
  console.log('STOCK_SYNC_INTERVAL_MINUTES ajustado de 1 para 15.')

  console.log('Disparando sync real (kind=both, dryRun=false)...')
  const result = await runSync({
    kind: 'both',
    trigger: 'manual',
    triggeredBy: 'claude-activate-fixadores-2026-09-08',
    dryRun: false,
  })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('ERRO:', err)
  process.exit(1)
})
