import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import path from 'node:path'
import fs from 'node:fs'

// Aplica as migrations geradas por `npm run db:generate` (drizzle-kit,
// le src/lib/db/schema.ts) no banco proprio desta integracao. Rodar apos
// deploy, antes de iniciar o servico web/worker -- mesmo padrao que a
// Reposicao usa (migration explicita, nunca "sync" magico de schema em
// producao).
const DATABASE_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'app.db')
fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true })

const sqlite = new Database(DATABASE_PATH)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

const db = drizzle(sqlite)

migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') })

console.log(`[migrate] OK -- banco em ${DATABASE_PATH}`)
sqlite.close()
