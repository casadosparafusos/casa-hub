import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import path from 'node:path'
import fs from 'node:fs'
import * as schema from '../src/lib/db/schema'
import { hashPassword } from '../src/lib/password-core'

// Cria (ou reativa) o usuario master admin/admin -- pedido explicito do
// usuario (04/09/2026): credencial simples de proposito, uso interno pra
// ele e a Claude acessarem o Hub antes de existir qualquer outro usuario
// cadastrado. Idempotente: rodar de novo so reseta a senha pra 'admin' e
// garante active=1, nunca duplica a linha (username e unique).
//
// Mesmo padrao de conexao do scripts/migrate.ts -- nao importa src/lib/db
// nem src/lib/password porque ambos tem `import 'server-only'`, que lanca
// erro incondicional fora da resolucao especial do bundler do Next.

const DATABASE_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), 'data', 'app.db')
fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true })

const sqlite = new Database(DATABASE_PATH)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

const db = drizzle(sqlite, { schema })

const USERNAME = 'admin'
const PASSWORD = 'admin'
const DISPLAY_NAME = 'Administrador'

const passwordHash = hashPassword(PASSWORD)
const existing = db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, USERNAME)).get()

if (existing) {
  db.update(schema.users)
    .set({ passwordHash, displayName: DISPLAY_NAME, active: true })
    .where(eq(schema.users.id, existing.id))
    .run()
  console.log(`[seed-admin] usuário 'admin' já existia (id=${existing.id}) -- senha e status resetados.`)
} else {
  const [row] = db
    .insert(schema.users)
    .values({ username: USERNAME, displayName: DISPLAY_NAME, passwordHash })
    .returning({ id: schema.users.id })
    .all()
  console.log(`[seed-admin] usuário 'admin' criado (id=${row?.id}).`)
}

console.log(`[seed-admin] OK -- login: ${USERNAME} / ${PASSWORD} (banco: ${DATABASE_PATH})`)
sqlite.close()
