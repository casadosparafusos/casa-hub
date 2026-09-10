import { readFileSync } from 'fs'
import { importWhitelistCsv } from '../src/lib/csv/import'

// Import unico da whitelist de Fixadores (2319 produtos, active=0 -- so
// cataloga, nao entra no sync ate ser ativado explicitamente depois).
// Rodado via script (nao pela UI) porque o loop resolve 1 SKU por vez na
// API do Wake (rate limit 120/min) e nao caberia no timeout de uma
// requisicao HTTP normal.

async function main() {
  const path = process.argv[2]
  if (!path) throw new Error('uso: tsx import-fixadores-bulk.ts <caminho-do-csv>')
  const content = readFileSync(path, 'utf-8')
  console.log(`Lendo ${path}...`)
  const result = await importWhitelistCsv(content, 'whitelist-fixadores-inactive.csv', 'claude-import-fixadores-2026-09-08')
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('ERRO:', err)
  process.exit(1)
})
