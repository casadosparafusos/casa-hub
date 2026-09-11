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
