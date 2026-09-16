/*
 * FASE B.4 §7 -- Relatorio READ-ONLY de elegibilidade a Tabela de Preco 74.
 *
 * Classifica cada managed_product ativo em ELIGIBLE_PRICE_TABLE_74 ou
 * NOT_ELIGIBLE_PRICE_TABLE_74, usando o MESMO gate de src/lib/sync/engine.ts
 * (priceResult.policy === 'FIXADOR_CENTO'), a partir da UNIT ja persistida
 * pela ultima sincronizacao (sync_product_state.unit_class /
 * unit_resolution_status) -- nao consulta CISS/Wake ao vivo.
 *
 * Como resolveCommercialPolicy() (src/lib/units/policy-resolver.ts) so aceita
 * override='NONE' hoje via parametro de chamada que NENHUMA linha de
 * managed_products persiste no banco ainda (ver comentario em
 * src/lib/units/compute.ts), a policy de producao real de um produto e 100%
 * determinada por unitClass: HUNDRED -> FIXADOR_CENTO, qualquer outra coisa
 * -> NONE. Este relatorio reflete exatamente isso -- nao inventa um campo
 * novo nem antecipa a coluna de override.
 *
 * ZERO escrita:
 *   - SQLite: readonly + query_only, so SELECT;
 *   - CISS: nao chamado;
 *   - Wake: nao chamado;
 *   - NAO remove nenhum vinculo real de Tabela 74 na Wake -- isso e so
 *     leitura local, para remediation futura controlada (fora de escopo
 *     desta fase).
 *
 * Saida:
 *   - artifacts-private/price-table-74-eligibility-<stamp>.{json,csv}: por
 *     SKU, NUNCA commitado (artifacts-private/ esta no .gitignore -- "casa-hub
 *     publico: nunca versionar dados por SKU");
 *   - agregados (contagem por classificacao/motivo, sem SKU) impressos em
 *     stderr -- esses sim podem ir pro relatorio final / docs.
 *
 * Uso:
 *   tsx scripts/price-table-74-eligibility-report.ts --root <app> [--db <app.db>] [--out <dir>]
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { assertNoSecrets, timestampForFile } from './reconcile/output'

type UnitClass = 'HUNDRED' | 'DIRECT' | 'PACKAGE_MEASURED'
type UnitResolutionStatus = 'OK' | 'UNSUPPORTED_UNIT' | 'CONFIGURATION_REQUIRED' | 'NO_STOCK_RECORD'
type Classification = 'ELIGIBLE_PRICE_TABLE_74' | 'NOT_ELIGIBLE_PRICE_TABLE_74'

interface ProductRow {
  managedProductId: number
  cissProductId: string
  wakeSku: string
  wakeVariantId: string
  unitRaw: string | null
  unitNormalized: string | null
  unitClass: UnitClass | null
  unitResolutionStatus: UnitResolutionStatus | null
}

interface ClassifiedRow extends ProductRow {
  classification: Classification
  reason: string
}

export function classify(row: Pick<ProductRow, 'unitClass' | 'unitResolutionStatus'>): { classification: Classification; reason: string } {
  if (!row.unitResolutionStatus) return { classification: 'NOT_ELIGIBLE_PRICE_TABLE_74', reason: 'NO_SYNC_STATE_YET' }
  if (row.unitResolutionStatus !== 'OK') return { classification: 'NOT_ELIGIBLE_PRICE_TABLE_74', reason: row.unitResolutionStatus }
  if (row.unitClass === 'HUNDRED') return { classification: 'ELIGIBLE_PRICE_TABLE_74', reason: 'FIXADOR_CENTO' }
  return { classification: 'NOT_ELIGIBLE_PRICE_TABLE_74', reason: row.unitClass ?? 'UNKNOWN' }
}

function parseArgs(argv: string[]): { root: string; db?: string; out: string } {
  let root = process.cwd()
  let db: string | undefined
  let out = 'artifacts-private'
  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1]
    if (next === undefined) continue
    if (argv[i] === '--root') {
      root = path.resolve(next)
      i++
    } else if (argv[i] === '--db') {
      db = path.resolve(next)
      i++
    } else if (argv[i] === '--out') {
      out = next
      i++
    }
  }
  return { root, db, out }
}

function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`)
}

function readRows(root: string, dbPath: string): ProductRow[] {
  const req = createRequire(path.join(root, 'package.json'))
  const Database = req('better-sqlite3') as new (file: string, opts: BetterSqlite3.Options) => BetterSqlite3.Database
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    return db
      .prepare(
        `SELECT mp.id AS managedProductId,
                mp.ciss_product_id AS cissProductId,
                mp.wake_sku AS wakeSku,
                mp.wake_product_variant_id AS wakeVariantId,
                sps.unit_raw AS unitRaw,
                sps.unit_normalized AS unitNormalized,
                sps.unit_class AS unitClass,
                sps.unit_resolution_status AS unitResolutionStatus
           FROM managed_products mp
           LEFT JOIN sync_product_state sps ON sps.managed_product_id = mp.id
          WHERE mp.active = 1
          ORDER BY mp.id`,
      )
      .all() as ProductRow[]
  } finally {
    db.close()
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = args.db ?? path.join(args.root, 'data', 'app.db')
  log(`[db] lendo em modo somente-leitura: ${dbPath}`)

  const rows = readRows(args.root, dbPath)
  log(`[db] ${rows.length} produtos ativos (whitelist)`)

  const classified: ClassifiedRow[] = rows.map((r) => ({ ...r, ...classify(r) }))

  const byClassification: Record<string, number> = {}
  const byReason: Record<string, number> = {}
  for (const r of classified) {
    byClassification[r.classification] = (byClassification[r.classification] ?? 0) + 1
    byReason[r.reason] = (byReason[r.reason] ?? 0) + 1
  }

  const aggregate = {
    generatedAt: new Date().toISOString(),
    totalActiveProducts: rows.length,
    byClassification,
    byReason,
    note:
      'READ-ONLY. Nao remove nenhum vinculo real de Tabela 74 na Wake. classification reflete o MESMO gate de src/lib/sync/engine.ts ' +
      '(priceResult.policy === "FIXADOR_CENTO"), a partir da UNIT ja persistida em sync_product_state pela ultima sincronizacao -- nao ' +
      'consulta CISS/Wake ao vivo.',
  }

  log(`[resultado] ${JSON.stringify(byClassification)}`)
  log(`[motivos] ${JSON.stringify(byReason)}`)

  const outDir = path.resolve(args.out)
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = timestampForFile(new Date())
  const jsonPath = path.join(outDir, `price-table-74-eligibility-${stamp}.json`)
  const csvPath = path.join(outDir, `price-table-74-eligibility-${stamp}.csv`)

  const fullReport = { ...aggregate, rows: classified }
  const json = JSON.stringify(fullReport, null, 2)
  const csvHeader = 'managed_product_id,ciss_product_id,wake_sku,wake_variant_id,unit_raw,unit_normalized,unit_class,unit_resolution_status,classification,reason'
  const csvRows = classified.map((r) =>
    [r.managedProductId, r.cissProductId, r.wakeSku, r.wakeVariantId, r.unitRaw ?? '', r.unitNormalized ?? '', r.unitClass ?? '', r.unitResolutionStatus ?? '', r.classification, r.reason]
      .map((v) => String(v))
      .join(','),
  )
  const csv = [csvHeader, ...csvRows].join('\n') + '\n'

  assertNoSecrets(json, [])
  assertNoSecrets(csv, [])
  fs.writeFileSync(jsonPath, json, { encoding: 'utf8', flag: 'wx' })
  fs.writeFileSync(csvPath, csv, { encoding: 'utf8', flag: 'wx' })
  log(`[artefatos] ${jsonPath}`)
  log(`[artefatos] ${csvPath}`)
  log('[aviso] per-SKU so em artifacts-private/ (gitignored) -- nunca commitar')

  return 0
}

if (require.main === module) process.exit(main())
