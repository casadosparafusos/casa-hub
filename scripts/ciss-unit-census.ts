/*
 * Censo READ-ONLY das unidades de medida do CISS (campo `unit`), no catalogo
 * inteiro do endpoint -- nao so na whitelist.
 *
 * NAO escreve em lugar nenhum alem dos dois artefatos locais (JSON + CSV):
 *   - CISS: so GET /products/stock em modo listagem (scripts/reconcile/http.ts);
 *   - SQLite: readonly + query_only, so SELECT (whitelist + token cifrado);
 *   - Wake: nao e chamada;
 *   - nao importa db/index, settings, wake/client nem sync da aplicacao.
 * Por produto guarda so product_id, reference, description e unit_raw --
 * estoque e descartado na leitura; preco nao e consultado.
 *
 * Uso:
 *   tsx scripts/ciss-unit-census.ts --root <app> [--env-file <.env>] [--db <app.db>]
 *       [--out <dir>] [--probe] [--per-page 500] [--page-delay-ms 1000]
 *       [--max-pages 400] [--timeout-ms 60000]
 *
 *   --probe  exatamente 1 GET /products/stock?page=1&per_page=<n>, sem retry;
 *            imprime so estrutura (status, chaves, paginacao) e nao grava arquivo.
 *
 * Saida: 0 = concluido; 3 = listagem nao suportada (probe != LISTING_SUPPORTED); 1 = falha.
 */
import path from 'node:path'
import { CissReader, CISS_DEFAULT_BASE_URL } from './reconcile/ciss-reader'
import { parseCensusArgs } from './reconcile/cli-args'
import { readDbSnapshot } from './reconcile/db-readonly'
import { loadEnvFile } from './reconcile/env-file'
import type { FetchLike } from './reconcile/http'
import { timestampForFile, writeCensusArtifacts, type CensusCsvRow } from './reconcile/output'
import { resolveSecret } from './reconcile/secrets'
import { aggregateUnits, normalizeUnit, probeStockListing, readCatalogUnits, STOCK_PATH, UNIT_DICTIONARY, UNSUPPORTED_MAPPING } from './reconcile/unit-census'

function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`)
}

async function main(): Promise<number> {
  const args = parseCensusArgs(process.argv.slice(2))
  if (args.envFile) log(`[env] ${loadEnvFile(args.envFile, process.env)} variaveis carregadas de ${path.basename(args.envFile)} (valores nao exibidos)`)
  const env = process.env
  const dbPath = args.db ?? (env.DATABASE_PATH ? path.resolve(env.DATABASE_PATH) : path.join(args.root, 'data', 'app.db'))
  log(`[db] lendo em modo somente-leitura: ${dbPath}`)
  const snapshot = readDbSnapshot(args.root, dbPath)
  log(`[db] whitelist: ${snapshot.products.length} produtos ativos`)

  const ciss = resolveSecret(snapshot.settings.get('CISS_API_TOKEN') ?? null, env.CISS_API_TOKEN, env.SETTINGS_SECRET_KEY)
  log(`[auth] token CISS: ${ciss.source} (valor nunca exibido)`)
  if (!ciss.value) {
    log('[erro] token CISS ausente -- nenhuma chamada de rede')
    return 1
  }
  const baseUrl = env.CISS_BASE_URL || CISS_DEFAULT_BASE_URL
  const fetchImpl = globalThis.fetch as unknown as FetchLike
  const secrets = [ciss.value, env.SETTINGS_SECRET_KEY, env.WAKE_ADMIN_API_TOKEN, env.CISS_API_TOKEN]

  if (args.probe) {
    log(`[probe] 1 GET ${STOCK_PATH}?page=1&per_page=${args.perPage} (sem retry)`)
    const t0 = Date.now()
    const probe = await probeStockListing({ token: ciss.value, fetchImpl, baseUrl, perPage: args.perPage, timeoutMs: args.timeoutMs })
    const text = JSON.stringify({ ...probe, duration_ms: Date.now() - t0, requests: 1 })
    for (const s of secrets) if (s && s.length >= 8 && text.includes(s)) throw new Error('segredo detectado na saida do probe -- nada exibido')
    log(`[probe] ${text}`)
    return probe.verdict === 'LISTING_SUPPORTED' ? 0 : 3
  }

  const started = new Date()
  const reader = new CissReader({ token: ciss.value, fetchImpl, baseUrl, timeoutMs: args.timeoutMs, maxAttempts: 3, retryDelayMs: 5000, log })
  log(`[census] listagem ${STOCK_PATH} per_page=${args.perPage}, sequencial, pausa ${args.pageDelayMs} ms, teto ${args.maxPages} paginas`)
  const catalog = await readCatalogUnits(reader, { perPage: args.perPage, pageDelayMs: args.pageDelayMs, maxPages: args.maxPages, log })
  const finished = new Date()
  const whitelistIds = snapshot.products.map((p) => p.cissProductId)
  const agg = aggregateUnits(catalog.products, whitelistIds)
  const wl = new Set(whitelistIds)

  const report = {
    meta: {
      kind: 'ciss-unit-census',
      started_at: started.toISOString(),
      finished_at: finished.toISOString(),
      duration_ms: finished.getTime() - started.getTime(),
      endpoint: `GET ${STOCK_PATH}?page=N&per_page=${args.perPage} (sem product_id)`,
      per_page: args.perPage,
      pages_read: catalog.pages_read,
      reported_total: catalog.reported_total,
      reported_total_pages: catalog.reported_total_pages,
      products_read: catalog.products.length,
      duplicates: catalog.duplicates,
      ciss_requests: catalog.requests,
      wake_requests: 0,
      writes: 0,
      whitelist_size: snapshot.products.length,
      warnings: catalog.warnings,
      token_source: ciss.source,
      note: 'Por produto: so product_id, reference, description, unit_raw. Sem preco, sem estoque.',
    },
    dictionary: { mapped: UNIT_DICTIONARY, default: UNSUPPORTED_MAPPING },
    units_raw: agg.raw,
    units_normalized: agg.normalized,
    whitelist: agg.whitelist,
    products: catalog.products.map((p) => ({ ...p, in_current_whitelist: wl.has(p.product_id) })),
  }
  const rows: CensusCsvRow[] = catalog.products.map((p) => ({
    product_id: p.product_id,
    reference: p.reference,
    description: p.description,
    unit_raw: p.unit_raw,
    unit_normalized: normalizeUnit(p.unit_raw),
    in_current_whitelist: wl.has(p.product_id),
  }))
  const { jsonPath, csvPath } = writeCensusArtifacts(args.out, timestampForFile(finished), report, rows, secrets)
  log(`[out] ${jsonPath}`)
  log(`[out] ${csvPath}`)
  log(`[resumo] paginas=${catalog.pages_read} produtos=${catalog.products.length} total_reportado=${String(catalog.reported_total)} repetidos=${catalog.duplicates} requests=${catalog.requests} warnings=${catalog.warnings.length}`)
  log(`[resumo] units: ${JSON.stringify(agg.normalized.map((u) => [u.unit_normalized, u.count_catalog, u.count_current_whitelist]))}`)
  log(`[resumo] whitelist: ${JSON.stringify(agg.whitelist.by_category)}`)
  return 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log(`[erro] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
