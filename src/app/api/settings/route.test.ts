import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NextRequest } from 'next/server'

vi.mock('server-only', () => ({}))

// FASE D-PRE §4/§5 (achados independentes do Tech Lead): nenhuma rota de API
// deste projeto tinha teste ate agora -- este arquivo estabelece o padrao
// (chamar GET()/PUT() exportados diretamente, sem subir um servidor HTTP de
// verdade) e cobre os dois achados que vivem neste mesmo modulo:
//
// §4 -- PUT /api/settings so validava chave-conhecida + string nao-vazia;
// agora um valor fora da faixa de SETTING_RANGES (ver src/lib/settings.ts)
// e rejeitado com 400 ANTES de persistir.
//
// §5 -- GET /api/settings nao exigia sessao nenhuma, vazando config/IDs Wake
// e quais segredos estao configurados (booleano) pra qualquer requisicao nao
// autenticada. Agora GET tambem chama requireSessionIdentity() (401 sem
// sessao, 200 com sessao) -- e a resposta nunca contem valor de segredo, so
// o booleano "configurado".
//
// requireSessionIdentity (src/lib/auth.ts) depende de next/headers (cookies
// reais de uma requisicao) -- fora de alcance de um teste unitario chamando
// o handler direto, entao a mockamos por completo e controlamos o retorno
// por teste.

const mockRequireSessionIdentity = vi.fn()
vi.mock('@/lib/auth', () => ({
  requireSessionIdentity: () => mockRequireSessionIdentity(),
}))

const FAKE_IDENTITY = { userId: 1, username: 'tester', displayName: 'Tester' }
const UNAUTHENTICATED = { error: true as const, status: 401 as const }

let db: typeof import('@/lib/db').db
let schema: typeof import('@/lib/db').schema
let settingsLib: typeof import('@/lib/settings')
let GET: typeof import('./route').GET
let PUT: typeof import('./route').PUT
let dbPath: string

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `casa-hub-settings-route-test-${process.pid}-${Date.now()}.db`)
  process.env.DATABASE_PATH = dbPath
  // setSecret()/getSecret() criptografam com AES-256-GCM derivado desta chave
  // (ver src/lib/crypto/secret-box.ts) -- sem ela, qualquer teste que grave
  // um segredo (mesmo so pra provar que GET nunca devolve o valor) lanca.
  process.env.SETTINGS_SECRET_KEY = 'test-only-secret-key-nao-usar-em-producao'

  const migrateSqlite = new Database(dbPath)
  migrateSqlite.pragma('journal_mode = WAL')
  migrate(drizzle(migrateSqlite), { migrationsFolder: path.join(process.cwd(), 'drizzle') })
  migrateSqlite.close()

  ;({ db, schema } = await import('@/lib/db'))
  settingsLib = await import('@/lib/settings')
  ;({ GET, PUT } = await import('./route'))
})

afterAll(() => {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(dbPath + suffix)
    } catch {
      /* melhor esforco -- arquivo temporario de teste */
    }
  }
})

beforeEach(async () => {
  await db.delete(schema.settings)
  mockRequireSessionIdentity.mockReset()
  mockRequireSessionIdentity.mockResolvedValue(FAKE_IDENTITY)
})

afterEach(() => {
  vi.clearAllMocks()
})

function fakePutRequest(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest
}

describe('GET /api/settings -- FASE D-PRE §5 (exige sessao)', () => {
  it('401 quando nao autenticado -- nunca chega a ler settings/segredos', async () => {
    mockRequireSessionIdentity.mockResolvedValue(UNAUTHENTICATED)
    const res = await GET()
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body).toEqual({ error: 'Não autenticado' })
  })

  it('200 quando autenticado -- corpo tem required/missing/rules/secrets', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('required')
    expect(body).toHaveProperty('missing')
    expect(body).toHaveProperty('rules')
    expect(body).toHaveProperty('secrets')
  })

  it('secrets nunca expõe o valor real -- so o booleano "configurado"', async () => {
    await settingsLib.setSecret('WAKE_ADMIN_API_TOKEN', 'token-super-secreto-de-producao', 'tester')
    const res = await GET()
    const body = await res.json()
    expect(body.secrets.WAKE_ADMIN_API_TOKEN).toBe(true)
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('token-super-secreto-de-producao')
  })
})

describe('PUT /api/settings -- FASE D-PRE §4 (valida faixa antes de persistir)', () => {
  it('401 quando nao autenticado', async () => {
    mockRequireSessionIdentity.mockResolvedValue(UNAUTHENTICATED)
    const res = await PUT(fakePutRequest({ key: 'STOCK_PERCENT', value: '15' }))
    expect(res.status).toBe(401)
  })

  it('invalido (fora de faixa) -> 400, nada persistido', async () => {
    const res = await PUT(fakePutRequest({ key: 'STOCK_PERCENT', value: '150' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/STOCK_PERCENT/)
    expect(await settingsLib.getSetting('STOCK_PERCENT')).toBeNull()
  })

  it('invalido (nao numerico) -> 400, nada persistido', async () => {
    const res = await PUT(fakePutRequest({ key: 'WAKE_CD_ID', value: 'abc' }))
    expect(res.status).toBe(400)
    expect(await settingsLib.getSetting('WAKE_CD_ID')).toBeNull()
  })

  it('invalido (WHOLESALE_MIN_QTY=0, precisa ser > 0) -> 400', async () => {
    const res = await PUT(fakePutRequest({ key: 'WHOLESALE_MIN_QTY', value: '0' }))
    expect(res.status).toBe(400)
  })

  it('valido -> 200 e persiste exatamente o valor enviado (comportamento inalterado)', async () => {
    const res = await PUT(fakePutRequest({ key: 'STOCK_PERCENT', value: '15' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(await settingsLib.getSetting('STOCK_PERCENT')).toBe('15')
  })

  it('valido (com espacos) -> 200 e persiste o valor trimado (revisao Tech Lead PR #4, fix #5)', async () => {
    const res = await PUT(fakePutRequest({ key: 'STOCK_PERCENT', value: ' 15 ' }))
    expect(res.status).toBe(200)
    expect(await settingsLib.getSetting('STOCK_PERCENT')).toBe('15')
  })

  it('invalido (so espacos) -> 400, nada persistido (revisao Tech Lead PR #4, fix #5)', async () => {
    const res = await PUT(fakePutRequest({ key: 'STOCK_PERCENT', value: '   ' }))
    expect(res.status).toBe(400)
    expect(await settingsLib.getSetting('STOCK_PERCENT')).toBeNull()
  })

  it('chave desconhecida -> 400 (whitelist, comportamento pre-existente preservado)', async () => {
    const res = await PUT(fakePutRequest({ key: 'CHAVE_INEXISTENTE', value: 'x' }))
    expect(res.status).toBe(400)
  })
})

describe('PUT /api/settings -- WAKE_STOCK_CONTROL_MODE (revisao Tech Lead PR #4, fix #3: enum fstore|erp)', () => {
  it('valido (fstore) -> 200, persiste exatamente o valor canonico', async () => {
    const res = await PUT(fakePutRequest({ key: 'WAKE_STOCK_CONTROL_MODE', value: 'fstore' }))
    expect(res.status).toBe(200)
    expect(await settingsLib.getSetting('WAKE_STOCK_CONTROL_MODE')).toBe('fstore')
  })

  it('valido (ERP maiusculo, com espacos) -> 200, persiste canonicalizado (trim + lowercase)', async () => {
    const res = await PUT(fakePutRequest({ key: 'WAKE_STOCK_CONTROL_MODE', value: ' ERP ' }))
    expect(res.status).toBe(200)
    expect(await settingsLib.getSetting('WAKE_STOCK_CONTROL_MODE')).toBe('erp')
  })

  it('invalido (fora de fstore|erp) -> 400, nada persistido', async () => {
    const res = await PUT(fakePutRequest({ key: 'WAKE_STOCK_CONTROL_MODE', value: 'qualquer-coisa' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/WAKE_STOCK_CONTROL_MODE/)
    expect(await settingsLib.getSetting('WAKE_STOCK_CONTROL_MODE')).toBeNull()
  })
})
