import 'server-only'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'
import * as schema from './schema'

// Banco proprio desta integracao -- NUNCA aponta pro app.db da Reposicao.
// Caminho configuravel via DATABASE_PATH (systemd EnvironmentFile em
// producao); default local pra dev/scaffolding.
const DATABASE_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'app.db')

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true })

const sqlite = new Database(DATABASE_PATH)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })
export { schema }
