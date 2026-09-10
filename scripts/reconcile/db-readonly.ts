import { createRequire } from 'node:module'
import path from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'

// Leitura do SQLite de producao em modo SOMENTE LEITURA.
//
// NAO importa src/lib/db/index.ts: aquele modulo abre o banco em
// leitura-escrita, cria o diretorio e seta journal_mode=WAL. Aqui:
//   - readonly: true + fileMustExist: true (nunca cria arquivo);
//   - PRAGMA query_only = ON (defesa extra: qualquer escrita falha);
//   - so SELECT.
// better-sqlite3 e resolvido a partir de --root (node_modules da instalacao),
// para o script poder rodar de fora do diretorio da aplicacao.

export interface ManagedProductRow {
  id: number
  cissProductId: string
  wakeVariantId: string
  wakeSku: string
}

export interface DbSnapshot {
  products: ManagedProductRow[]
  /** key -> value cru da tabela settings (segredos continuam cifrados aqui). */
  settings: Map<string, string | null>
}

type DatabaseCtor = new (file: string, opts: BetterSqlite3.Options) => BetterSqlite3.Database

export function readDbSnapshot(root: string, dbPath: string): DbSnapshot {
  const req = createRequire(path.join(root, 'package.json'))
  const Database = req('better-sqlite3') as DatabaseCtor
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    const products = db
      .prepare(
        `SELECT id, ciss_product_id AS cissProductId, wake_product_variant_id AS wakeVariantId, wake_sku AS wakeSku
           FROM managed_products
          WHERE active = 1
          ORDER BY id`,
      )
      .all() as ManagedProductRow[]
    const settingsRows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string | null }>
    return {
      products: products.map((p) => ({
        id: p.id,
        cissProductId: String(p.cissProductId).trim(),
        wakeVariantId: String(p.wakeVariantId).trim(),
        wakeSku: String(p.wakeSku).trim(),
      })),
      settings: new Map(settingsRows.map((r) => [r.key, r.value])),
    }
  } finally {
    db.close()
  }
}

/** Settings nao-secretos: env tem prioridade sobre o banco (mesma regra de getSetting). */
export function settingValue(settings: Map<string, string | null>, env: NodeJS.ProcessEnv, key: string): string | null {
  const e = env[key]
  if (e && e.trim() !== '') return e.trim()
  const v = settings.get(key)
  return v != null && v.trim() !== '' ? v.trim() : null
}
