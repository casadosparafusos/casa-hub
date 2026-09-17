// FASE B (§18) -- demonstracao local/read-only do motor puro de UNIT.
// So importa o modulo puro (src/lib/units/compute.ts): zero Wake,
// zero CISS, zero DB, zero write. Fixtures sanitizadas (sem SKU real), exceto
// o caso PC que reproduz o exemplo ja publico no proprio prompt da fase (§17).
//
// Rodar: npx tsx scripts/reconcile/demo-dry-run.ts

import { computeUnit } from '../../src/lib/units/compute'

type Case = { label: string; input: Parameters<typeof computeUnit>[0] }

const cases: Case[] = [
  { label: 'CT (fixador, grupo de 2298 produtos)', input: { unitRaw: 'CT', cissPrice: 300, cissStock: 2.3 } },
  { label: 'PC (caso real auditado, ja publicado no prompt da fase)', input: { unitRaw: 'PC', cissPrice: 2.07, cissStock: 1894 } },
  { label: 'KG sem config cadastrada', input: { unitRaw: 'KG', cissPrice: 12.5, cissStock: 340 } },
  { label: 'MT sem config cadastrada', input: { unitRaw: 'MT', cissPrice: 8, cissStock: 37 } },
  { label: 'Unknown (UNIT fora do mapa canonico)', input: { unitRaw: 'ZZ', cissPrice: 10, cissStock: 5 } },
]

for (const { label, input } of cases) {
  const result = computeUnit(input)
  console.log(`\n=== ${label} ===`)
  console.log('input :', input)
  console.log('output:', result)
  console.log('write? :', result.ok ? 'planned (dry-run, nunca write real)' : 'ZERO WRITE (fail-closed)')
}
