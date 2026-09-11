import path from 'node:path'

// Argumentos do CLI scripts/reconcile-readonly.ts. Modulo separado para ser
// testavel sem executar o main().

export const DEFAULT_CISS_CONCURRENCY = 1
export const MAX_CISS_CONCURRENCY = 4

export interface CliArgs {
  root: string
  envFile: string | null
  db: string | null
  out: string
  fullScan: boolean
  plan: boolean
  /** GETs de estoque CISS simultaneos. Default 1: a auditoria roda com o worker de producao ligado. */
  cissConcurrency: number
}

// Argumentos do CLI scripts/ciss-unit-census.ts.
export interface CensusArgs {
  root: string
  envFile: string | null
  db: string | null
  out: string
  /** Exatamente 1 GET (page=1), sem retry, sem gravar arquivo. */
  probe: boolean
  perPage: number
  pageDelayMs: number
  maxPages: number
  timeoutMs: number
}

function intInRange(flag: string, raw: string, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} deve ser inteiro entre ${min} e ${max} (recebido: ${raw})`)
  return n
}

export function parseCensusArgs(argv: string[]): CensusArgs {
  const args: CensusArgs = {
    root: process.cwd(),
    envFile: null,
    db: null,
    out: path.resolve('artifacts'),
    probe: false,
    perPage: 500,
    pageDelayMs: 1000,
    maxPages: 400,
    timeoutMs: 60_000,
  }
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
    else if (a === '--probe') args.probe = true
    else if (a === '--per-page') args.perPage = intInRange(a, next(), 1, 500)
    else if (a === '--page-delay-ms') args.pageDelayMs = intInRange(a, next(), 250, 60_000)
    else if (a === '--max-pages') args.maxPages = intInRange(a, next(), 1, 2000)
    else if (a === '--timeout-ms') args.timeoutMs = intInRange(a, next(), 1000, 300_000)
    else throw new Error(`argumento desconhecido: ${a}`)
  }
  return args
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    root: process.cwd(),
    envFile: null,
    db: null,
    out: path.resolve('artifacts'),
    fullScan: false,
    plan: false,
    cissConcurrency: DEFAULT_CISS_CONCURRENCY,
  }
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
    else if (a === '--ciss-concurrency') {
      const raw = next()
      const n = Number(raw)
      if (!Number.isInteger(n) || n < 1 || n > MAX_CISS_CONCURRENCY) {
        throw new Error(`--ciss-concurrency deve ser inteiro entre 1 e ${MAX_CISS_CONCURRENCY} (recebido: ${raw})`)
      }
      args.cissConcurrency = n
    } else throw new Error(`argumento desconhecido: ${a}`)
  }
  return args
}
