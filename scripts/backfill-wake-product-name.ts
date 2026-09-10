import { eq, isNull } from 'drizzle-orm'
import { db, schema } from '../src/lib/db'
import { getWakeProductBySku, WakeClientError } from '../src/lib/wake/client'

// Backfill de wake_product_name pras linhas de managed_products importadas
// antes dessa coluna existir (migration drizzle/0002_striped_miek.sql).
// So preenche onde wake_product_name IS NULL -- reexecutavel sem risco.
//
// Rate limit do Wake: 120 req/min por grupo de endpoint, 5 throttles (429)
// seguidos travam o token por 1h (ver src/lib/wake/client.ts). Aqui rodamos
// SEQUENCIAL com pausa de 600ms entre chamadas (~100/min, com folga) --
// nao ha pressa nenhuma nesse backfill, e o risco de lockout de 1h em
// producao (bloquearia TAMBEM os syncs de preco/estoque) e muito pior que
// o backfill demorar ~25min pros ~2318 produtos.

const DELAY_MS = 600

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const rows = await db.select().from(schema.managedProducts).where(isNull(schema.managedProducts.wakeProductName))
  console.log(`Produtos sem nome cadastrado: ${rows.length}`)

  let updated = 0
  let notFound = 0
  let failed = 0

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    try {
      const product = await getWakeProductBySku(row.wakeSku)
      if (!product) {
        notFound++
        console.log(`[${i + 1}/${rows.length}] SKU ${row.wakeSku} nao encontrado no Wake`)
      } else if (product.nome) {
        await db.update(schema.managedProducts).set({ wakeProductName: product.nome }).where(eq(schema.managedProducts.id, row.id))
        updated++
      } else {
        console.log(`[${i + 1}/${rows.length}] SKU ${row.wakeSku} sem campo "nome" na resposta do Wake`)
      }
    } catch (err) {
      failed++
      const msg = err instanceof WakeClientError ? err.message : err instanceof Error ? err.message : String(err)
      console.log(`[${i + 1}/${rows.length}] SKU ${row.wakeSku} ERRO: ${msg}`)
    }

    if (i < rows.length - 1) await sleep(DELAY_MS)
  }

  console.log(`BACKFILL FINISHED: atualizados=${updated} nao_encontrados=${notFound} falhas=${failed} total=${rows.length}`)
}

main().catch((err) => {
  console.error('ERRO FATAL:', err)
  process.exit(1)
})
