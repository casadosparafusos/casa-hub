import 'server-only'
import { randomBytes, createHash } from 'node:crypto'
import { cookies, headers } from 'next/headers'
import { eq } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { hashPassword, verifyPassword } from '@/lib/password'

// -----------------------------------------------------------------------
// Autenticacao PROPRIA do Casa Hub (03/09/2026) -- o app saiu do ecossistema
// do Portal Interno (auth_request/nginx + X-Auth-* headers) porque vai
// operar num servidor 24/7 separado. Sessao por cookie httpOnly, validada
// direto no banco deste app (tabelas users/sessions em src/lib/db/schema.ts).
//
// Acesso e GERAL: qualquer usuario cadastrado e ativo tem acesso completo a
// todas as telas/rotas -- nao ha tabela de permissao por app/feature aqui
// (pedido explicito do usuario). "Identity" so carrega quem-e, nao o-que-pode.
//
// Mesmo padrao de seguranca do Portal: o cookie carrega um token aleatorio
// opaco; so o SHA-256 dele e gravado como id da sessao (nunca o token cru).
// -----------------------------------------------------------------------

const COOKIE_NAME = 'casahub_session'
const SESSION_TTL_DAYS = 30

export interface SessionIdentity {
  userId: number
  username: string
  displayName: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function isoInDays(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

/** Cria a sessao no banco e devolve o token cru (so este momento o ve). */
async function createSessionToken(userId: number): Promise<string> {
  const token = randomBytes(32).toString('hex')
  await db.insert(schema.sessions).values({
    id: hashToken(token),
    userId,
    expiresAt: isoInDays(SESSION_TTL_DAYS),
  })
  return token
}

/** Registra a sessao e grava o cookie httpOnly na resposta atual. */
export async function establishSession(userId: number): Promise<void> {
  const token = await createSessionToken(userId)
  const jar = await cookies()
  const hdrs = await headers()
  // "secure" precisa refletir o protocolo REAL da requisicao (via
  // X-Forwarded-Proto, que o nginx sempre repassa), nao process.env.NODE_ENV.
  // O deploy atual e HTTP puro (sem porta 443/TLS) -- um cookie Secure nesse
  // cenario e silenciosamente descartado pelo navegador, e o login "funciona"
  // (200) mas a sessao nunca pega.
  const isHttps = hdrs.get('x-forwarded-proto') === 'https'
  jar.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  })
}

export async function destroySession(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(COOKIE_NAME)?.value
  if (token) {
    await db.delete(schema.sessions).where(eq(schema.sessions.id, hashToken(token)))
  }
  jar.delete(COOKIE_NAME)
}

/** Le o cookie de sessao e resolve a identidade -- null se ausente/expirada/invalida. */
export async function getSessionIdentity(): Promise<SessionIdentity | null> {
  const jar = await cookies()
  const token = jar.get(COOKIE_NAME)?.value
  if (!token) return null

  const row = await db
    .select({
      userId: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      active: schema.users.active,
      expiresAt: schema.sessions.expiresAt,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.id, hashToken(token)))
    .get()

  if (!row || !row.active) return null
  if (new Date(row.expiresAt.replace(' ', 'T') + 'Z').getTime() < Date.now()) return null

  return { userId: row.userId, username: row.username, displayName: row.displayName }
}

/** Pra rotas de API (nao passam por layout): 401 explicito se nao autenticado. */
export async function requireSessionIdentity(): Promise<SessionIdentity | { error: true; status: 401 }> {
  const identity = await getSessionIdentity()
  if (!identity) return { error: true, status: 401 }
  return identity
}

// --- Cadastro / login -------------------------------------------------

export interface RegisterResult {
  ok: true
  userId: number
}

export async function registerUser(username: string, displayName: string, password: string): Promise<RegisterResult> {
  const existing = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.username, username)).get()
  if (existing) throw new Error('Usuário já cadastrado.')

  const passwordHash = hashPassword(password)
  const [row] = await db
    .insert(schema.users)
    .values({ username, displayName, passwordHash })
    .returning({ id: schema.users.id })

  if (!row) throw new Error('Falha ao criar usuário.')
  return { ok: true, userId: row.id }
}

export async function verifyLogin(username: string, password: string): Promise<{ userId: number } | null> {
  const row = await db
    .select({ id: schema.users.id, passwordHash: schema.users.passwordHash, active: schema.users.active })
    .from(schema.users)
    .where(eq(schema.users.username, username))
    .get()

  if (!row || !row.active) return null
  if (!verifyPassword(password, row.passwordHash)) return null

  await db.update(schema.users).set({ lastLoginAt: new Date().toISOString() }).where(eq(schema.users.id, row.id))
  return { userId: row.id }
}
