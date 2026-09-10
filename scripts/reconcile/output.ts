import fs from 'node:fs'
import path from 'node:path'
import type { ReconciliationRow } from './reconcile'

// Artefatos locais do relatorio (JSON + CSV). Nunca contem token, cookie,
// segredo ou header de auth: o conteudo e montado so a partir de dados de
// produto, e antes de gravar e varrido contra os segredos em memoria --
// se algum aparecer, NADA e gravado.

export const CSV_COLUMNS: Array<keyof ReconciliationRow> = [
  'ciss_product_id',
  'wake_sku',
  'wake_variant_id',
  'unit',
  'unit_raw',
  'ciss_price',
  'ciss_stock',
  'ciss_enterprise',
  'ciss_location',
  'package_weight_kg',
  'expected_retail_price',
  'expected_wholesale_price',
  'wake_current_price',
  'price_match',
  'expected_stock',
  'wake_current_stock',
  'stock_match',
  'price_table_expected',
  'price_table_actual',
  'price_table_match',
  'wake_variant_id_actual',
  'wake_preco_de',
  'price_table_preco_de_actual',
  'status',
  'error',
]

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'string' ? value : String(value)
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: ReconciliationRow[]): string {
  const lines = [CSV_COLUMNS.join(',')]
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))
  return lines.join('\n') + '\n'
}

export function timestampForFile(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/** Lanca se qualquer segredo (>= 8 chars) aparecer no texto. */
export function assertNoSecrets(text: string, secrets: Array<string | null | undefined>): void {
  for (const s of secrets) {
    if (s && s.length >= 8 && text.includes(s)) {
      throw new Error('segredo detectado no conteudo do relatorio -- gravacao cancelada')
    }
  }
}

export function writeArtifacts(
  outDir: string,
  stamp: string,
  report: { rows: ReconciliationRow[] } & Record<string, unknown>,
  secrets: Array<string | null | undefined>,
): { jsonPath: string; csvPath: string } {
  const json = JSON.stringify(report, null, 2)
  const csv = toCsv(report.rows)
  assertNoSecrets(json, secrets)
  assertNoSecrets(csv, secrets)
  fs.mkdirSync(outDir, { recursive: true })
  const jsonPath = path.join(outDir, `reconciliation-${stamp}.json`)
  const csvPath = path.join(outDir, `reconciliation-${stamp}.csv`)
  fs.writeFileSync(jsonPath, json, { encoding: 'utf8', flag: 'wx' })
  fs.writeFileSync(csvPath, csv, { encoding: 'utf8', flag: 'wx' })
  return { jsonPath, csvPath }
}
