import { runSync } from '../src/lib/sync/engine'

// Script de verificacao pontual (09/09/2026): dispara um sync de PRECO real
// (dryRun=false, trigger='manual') pra confirmar que o fix do bug de raiz
// do `tipoIdentificador` (query param, nao campo do corpo -- ver
// docs/WAKE-API-CONTRATOS.md e client.ts) tambem corrige o preco, nao so o
// estoque. Nao mexe no relogio do worker (so runs trigger='scheduled'
// contam pro intervalo de 24h), entao e seguro rodar sem bagunçar a
// agenda automatica.
//
// Rodar no servidor com o .env real carregado:
//   set -a; source .env; set +a; npx tsx --conditions=react-server scripts/verify-price-sync.ts

async function main() {
  console.log('[verify-price-sync] iniciando sync kind=price trigger=manual dryRun=false')
  const result = await runSync({ kind: 'price', dryRun: false, trigger: 'manual', triggeredBy: 'claude-verify' })
  console.log('[verify-price-sync] resultado:', JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('[verify-price-sync] falhou:', err)
  process.exitCode = 1
})
