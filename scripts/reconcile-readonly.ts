/*
 * Reconciliador READ-ONLY do Casa Hub: CISS real -> UNIT -> regra esperada -> Wake real.
 *
 * NAO escreve em lugar nenhum alem dos dois artefatos locais (JSON + CSV):
 *   - Wake e CISS: so GET (scripts/reconcile/http.ts e o unico ponto de rede);
 *   - SQLite: readonly + query_only, so SELECT;
 *   - nao importa db/index, settings, wake/client nem sync da aplicacao.
 *
 * Uso:
 *   tsx scripts/reconcile-readonly.ts --root <app> [--env-file <.env>] [--db <app.db>]
 *       [--out <dir>] [--full-scan] [--plan]
 *
 *   --root       diretorio da aplicacao (node_modules/better-sqlite3). Default: cwd.
 *   --env-file   carrega KEY=VALUE sem sobrescrever o env ja definido (nada e impresso).
 *   --db         caminho do SQLite. Default: $DATABASE_PATH ou <root>/data/app.db.
 *   --out        diretorio dos artefatos. Default: ./artifacts.
 *   --full-scan  varre /produtos inteiro em vez do intervalo de produtoVarianteId da whitelist.
 *   --plan       so le o SQLite e imprime o plano/estimativa -- nenhuma chamada de rede.
 *
 * Saida: 0 = concluido; 2 = concluido com leitura abortada (artefatos parciais gravados); 1 = falha.
 */
import fs from 'node:fs'
import path from 'node:path'
import { readDbSnapshot, settingValue } from './reconcile/db-readonly'
import type { FetchLike } from './reconcile/http'
import { timestampForFile, writeArtifacts } from './reconcile/output'
import { runReconciliation, variantRange } from './reconcile/run'
import { resolveSecret } from './reconcile/secrets'

interface CliArgs {
  root: string
  envFile: string | null
  db: string | null
  out: string
  fullScan: boolean
  plan: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { root: process.cwd(), envFile: null, db: null, out: path.resolve('artifacts'), fullScan: false, plan: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`faltou valor para ${a}`)
      return v
    }
    if (a === '--root') args.root = path.resolve(next())
    else if (a === '--env-file') args.envFile = path.resolve(next())
    else if (a === '--db') args.db = path.resolve(next())
    else if (a === '--out') args.out = path.resolve(next())
    else if (a === '--full-scan') args.fullScan = true
    else if (a === '--plan') args.plan = true
    else throw new Error(`argumento desconhecido: ${a}`)
  }
  return args
}

/** Parser minimo de .env (KEY=VALUE, aspas opcionais). Nao sobrescreve o env existente. */
export function loadEnvFile(file: string, env: NodeJS.ProcessEnv): number {
  let loaded = 0
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || !m[1]) continue
    let value = (m[2] ?? '').trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (env[m[1]] === undefined) {
      env[m[1]] = value
      loaded++
    }
  }
  return loaded
}

function log(msg: string): void {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`)
}

function intSetting(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) ? n : null
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.envFile) log(`[env] ${loadEnvFile(args.envFile, process.env)} variaveis carregadas de ${path.basename(args.envFile)} (valores nao exibidos)`)

  const dbPath = args.db ?? (process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH) : path.join(args.root, 'data', 'app.db'))
  log(`[db] lendo em modo somente-leitura: ${dbPath}`)
  const snapshot = readDbSnapshot(args.root, dbPath)
  const env = process.env
  const s = (key: string) => settingValue(snapshot.settings, env, key)

  const wakeCdId = intSetting(s('WAKE_CD_ID'))
  const priceTableId = intSetting(s('WAKE_PRICE_TABLE_ID'))
  const promotionId = intSetting(s('WAKE_PROMOTION_ID'))
  const cissEnterprise = intSetting(s('CISS_STOCK_ENTERPRISE')) ?? 2
  const cissLocation = intSetting(s('CISS_STOCK_LOCATION')) ?? 5
  const observed = {
    UNIT_PRICE_MARKUP_PERCENT: s('UNIT_PRICE_MARKUP_PERCENT'),
    STOCK_PERCENT: s('STOCK_PERCENT'),
    WHOLESALE_MIN_QTY: s('WHOLESALE_MIN_QTY'),
    CISS_PRICE_PROVIDER: env.CISS_PRICE_PROVIDER ?? null,
  }
  const divergences: string[] = []
  if (observed.UNIT_PRICE_MARKUP_PERCENT !== null && Number(observed.UNIT_PRICE_MARKUP_PERCENT) !== 20) divergences.push(`UNIT_PRICE_MARKUP_PERCENT=${observed.UNIT_PRICE_MARKUP_PERCENT} (regra canonica: 20)`)
  if (observed.STOCK_PERCENT !== null && Number(observed.STOCK_PERCENT) !== 10) divergences.push(`STOCK_PERCENT=${observed.STOCK_PERCENT} (regra canonica: 10)`)
  if (observed.WHOLESALE_MIN_QTY !== null && Number(observed.WHOLESALE_MIN_QTY) !== 100) divergences.push(`WHOLESALE_MIN_QTY=${observed.WHOLESALE_MIN_QTY} (regra canonica: 100)`)

  const range = variantRange(snapshot.products)
  log(`[db] ${snapshot.products.length} produtos ativos; CD=${wakeCdId} tabela=${priceTableId} promocao=${promotionId} CISS empresa=${cissEnterprise} local=${cissLocation}`)
  log(`[db] intervalo produtoVarianteId da whitelist: ${range ? `${range.minVariantId}..${range.maxVariantId}` : 'indisponivel'}`)
  if (divergences.length > 0) log(`[db] settings divergentes da regra canonica: ${divergences.join('; ')}`)

  if (wakeCdId === null) {
    log('[erro] WAKE_CD_ID nao configurado -- abortando antes de qualquer chamada de rede')
    return 1
  }
  if (snapshot.products.length === 0) {
    log('[erro] whitelist vazia (managed_products ativos = 0) -- nada a reconciliar, nenhuma chamada de rede')
    return 1
  }
  if (!range && !args.fullScan) {
    log('[erro] intervalo de produtoVarianteId indisponivel -- use --full-scan explicitamente para varrer o catalogo inteiro')
    return 1
  }

  if (args.plan) {
    const n = snapshot.products.length
    const productPages = range ? `<= ${Math.ceil((range.maxVariantId - range.minVariantId + 1) / 50)} (limite superior pelo intervalo; real = variantes existentes no intervalo / 50)` : 'catalogo inteiro / 50'
    const tablePages = Math.ceil(n / 50) + 1
    log(`[plan] Wake GET /produtos: ${productPages} paginas; GET /tabelaPrecos/${priceTableId}/produtos: ~${tablePages} paginas (se a tabela tiver so a whitelist); GET /promocoes/${promotionId}: 1`)
    log(`[plan] Wake: 1 request a cada 2s (30 req/min) -- tempo ~ total de requests / 30 minutos`)
    log(`[plan] CISS: ${Math.ceil(n / 150)} requests de preco + ${n} de estoque (concorrencia 3)`)
    log('[plan] nenhuma chamada de rede feita (--plan)')
    return 0
  }

  const wake = resolveSecret(snapshot.settings.get('WAKE_ADMIN_API_TOKEN') ?? null, env.WAKE_ADMIN_API_TOKEN, env.SETTINGS_SECRET_KEY)
  const ciss = resolveSecret(snapshot.settings.get('CISS_API_TOKEN') ?? null, env.CISS_API_TOKEN, env.SETTINGS_SECRET_KEY)
  log(`[auth] token Wake: ${wake.source}; token CISS: ${ciss.source} (valores nunca exibidos)`)

  const fetchImpl = globalThis.fetch as unknown as FetchLike
  const report = await runReconciliation({
    products: snapshot.products,
    wakeToken: wake.value,
    cissToken: ciss.value,
    wakeCdId,
    priceTableId,
    promotionId,
    cissEnterprise,
    cissLocation,
    wakeFetch: fetchImpl,
    cissFetch: fetchImpl,
    ...(env.CISS_BASE_URL ? { cissBaseUrl: env.CISS_BASE_URL } : {}),
    useVariantRange: !args.fullScan,
    log,
    extraMeta: {
      settings_observed: observed,
      settings_divergences: divergences,
      token_sources: { wake: wake.source, ciss: ciss.source },
      whitelist_variant_range: range,
    },
  })

  const stamp = timestampForFile(new Date())
  const { jsonPath, csvPath } = writeArtifacts(args.out, stamp, { ...report }, [wake.value, ciss.value, env.SETTINGS_SECRET_KEY])
  log(`[out] ${jsonPath}`)
  log(`[out] ${csvPath}`)
  log(`[resumo] ${JSON.stringify(report.aggregates)}`)
  log(`[resumo] promocao: ${report.promotion_check?.status ?? 'nao lida'}; wake_requests=${String(report.meta.wake_requests)} ciss_requests=${String(report.meta.ciss_requests)}`)
  return report.meta.aborted ? 2 : 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    log(`[erro] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  },
)
