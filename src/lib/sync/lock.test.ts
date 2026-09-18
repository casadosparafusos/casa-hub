import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// FASE D-PRE §7 (achado independente do Tech Lead): lock.ts nao tinha
// nenhum teste dedicado. O fix ja aplicado (padrao owner-token: acquireLock
// devolve um token unico por aquisicao, releaseLock so limpa se o token
// bater com o dono atual) resolve uma corrida de verdade: TTL expirado (ou
// PID do dono morto) deixava outro processo roubar o lock via UPDATE
// condicional, mas o dono original, ao terminar, chamava releaseLock(resource)
// SEM condicao nenhuma -- limpando o lock do novo dono legitimo enquanto ele
// ainda rodava. Este arquivo prova essa corrida especifica (owner A adquire
// -> lock passa a owner B via expiracao/PID morto -> release do owner A vira
// no-op -> B continua dono) alem do comportamento basico de
// acquire/release/withLocks.

vi.mock('server-only', () => ({}))

let db: typeof import('../db').db
let schema: typeof import('../db').schema
let lock: typeof import('./lock')
let dbPath: string

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `casa-hub-lock-test-${process.pid}-${Date.now()}.db`)
  process.env.DATABASE_PATH = dbPath

  const migrateSqlite = new Database(dbPath)
  migrateSqlite.pragma('journal_mode = WAL')
  migrate(drizzle(migrateSqlite), { migrationsFolder: path.join(process.cwd(), 'drizzle') })
  migrateSqlite.close()

  ;({ db, schema } = await import('../db'))
  lock = await import('./lock')
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
  await db.delete(schema.jobLocks)
  await db.delete(schema.syncRuns)
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function readLockRow(resource: string) {
  return db.select().from(schema.jobLocks).where(eq(schema.jobLocks.resource, resource)).get()
}

async function seedLockRow(resource: string, lockedBy: string, expiresAtIso: string) {
  await db.insert(schema.jobLocks).values({ resource, lockedAt: new Date().toISOString(), lockedBy, expiresAt: expiresAtIso }).onConflictDoNothing()
  await db.update(schema.jobLocks).set({ lockedBy, expiresAt: expiresAtIso }).where(eq(schema.jobLocks.resource, resource)).run()
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString()
const PAST = new Date(Date.now() - 60 * 1000).toISOString()

describe('acquireLock/releaseLock -- basico', () => {
  it('adquire um recurso livre e devolve um token contendo o pid do processo atual', async () => {
    const token = await lock.acquireLock('preco', 'web:tester')
    expect(token).toBe(`web:tester#pid${process.pid}`)
    const row = await readLockRow('preco')
    expect(row?.lockedBy).toBe(token)
  })

  it('releaseLock com o token certo libera o recurso', async () => {
    const token = await lock.acquireLock('preco', 'web:tester')
    await lock.releaseLock('preco', token)
    const row = await readLockRow('preco')
    expect(row?.lockedBy).toBeNull()
    expect(row?.expiresAt).toBeNull()
  })

  it('releaseLock com token errado (dono diferente) e um no-op -- nao libera o lock de outro dono', async () => {
    const token = await lock.acquireLock('preco', 'web:tester')
    await lock.releaseLock('preco', 'token-que-nunca-foi-emitido')
    const row = await readLockRow('preco')
    expect(row?.lockedBy).toBe(token) // continua ocupado pelo dono real
  })

  it('recurso ocupado por dono vivo e nao expirado: acquireLock lanca LockUnavailableError, nao rouba', async () => {
    await seedLockRow('estoque', 'ownerA#pid123456', FUTURE)
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 123456) return true // dono "vivo"
      throw Object.assign(new Error('unexpected pid in test'), { code: 'ESRCH' })
    })

    await expect(lock.acquireLock('estoque', 'ownerB')).rejects.toThrow(lock.LockUnavailableError)
    const row = await readLockRow('estoque')
    expect(row?.lockedBy).toBe('ownerA#pid123456') // intocado
  })
})

describe('acquireLock -- corrida de dono (FASE D-PRE §7)', () => {
  it('TTL expirado: rouba o lock mesmo com o dono anterior "vivo" (backstop de crash tem prioridade)', async () => {
    await seedLockRow('estoque', 'ownerA#pid123456', PAST)
    vi.spyOn(process, 'kill').mockReturnValue(true) // dono anterior "vivo" -- irrelevante, TTL ja expirou

    const tokenB = await lock.acquireLock('estoque', 'ownerB')
    expect(tokenB).toBe(`ownerB#pid${process.pid}`)
    const row = await readLockRow('estoque')
    expect(row?.lockedBy).toBe(tokenB)
  })

  it('PID do dono morto (nao expirado ainda): rouba na hora, sem esperar o TTL', async () => {
    await seedLockRow('estoque', 'ownerA#pid999999', FUTURE)
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === 999999) throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      return true
    })

    const tokenB = await lock.acquireLock('estoque', 'ownerB')
    expect(tokenB).toBe(`ownerB#pid${process.pid}`)
  })

  it('cenario central do §7: apos o lock passar a B (roubo), o release do dono original A vira no-op e B continua dono', async () => {
    const tokenA = await lock.acquireLock('estoque', 'ownerA')
    // Forca a expiracao do TTL diretamente no banco (simula uma run de A que
    // passou do backstop de 3h sem nunca chamar releaseLock -- ex.: crash).
    await db.update(schema.jobLocks).set({ expiresAt: PAST }).where(eq(schema.jobLocks.resource, 'estoque')).run()

    const tokenB = await lock.acquireLock('estoque', 'ownerB')
    expect(tokenB).not.toBe(tokenA)

    // A "termina" agora (crash tardio, restart, etc.) e tenta liberar com o
    // TOKEN ANTIGO -- antes do fix do §7 isso limpava o lock de B na cara-dura.
    await lock.releaseLock('estoque', tokenA)

    const row = await readLockRow('estoque')
    expect(row?.lockedBy).toBe(tokenB) // B continua dono, intocado pelo release de A
    expect(row?.expiresAt).not.toBeNull()

    // So o release de B (o dono de fato) libera o recurso.
    await lock.releaseLock('estoque', tokenB)
    const released = await readLockRow('estoque')
    expect(released?.lockedBy).toBeNull()
  })
})

describe('withLocks', () => {
  it('adquire todos os recursos em ordem alfabetica e libera todos ao final, mesmo com sucesso', async () => {
    const result = await lock.withLocks(['zeta', 'alfa', 'beta'], 'web:tester', async () => {
      const [a, b, z] = await Promise.all([readLockRow('alfa'), readLockRow('beta'), readLockRow('zeta')])
      expect(a?.lockedBy).toContain('web:tester')
      expect(b?.lockedBy).toContain('web:tester')
      expect(z?.lockedBy).toContain('web:tester')
      return 'ok'
    })

    expect(result).toBe('ok')
    for (const resource of ['zeta', 'alfa', 'beta']) {
      const row = await readLockRow(resource)
      expect(row?.lockedBy).toBeNull()
    }
  })

  it('libera todos os locks ja adquiridos mesmo se fn lancar', async () => {
    await expect(
      lock.withLocks(['alfa', 'beta'], 'web:tester', async () => {
        throw new Error('falha proposital dentro de fn')
      }),
    ).rejects.toThrow('falha proposital dentro de fn')

    for (const resource of ['alfa', 'beta']) {
      const row = await readLockRow(resource)
      expect(row?.lockedBy).toBeNull()
    }
  })

  it('se um recurso do meio da lista ja estiver ocupado por outro dono vivo, libera so os que ja tinha adquirido e propaga o erro', async () => {
    await seedLockRow('beta', 'outroDono#pid555555', FUTURE)
    vi.spyOn(process, 'kill').mockReturnValue(true) // dono "vivo" -- nao rouba

    await expect(lock.withLocks(['alfa', 'beta', 'zeta'], 'web:tester', async () => 'nunca chega aqui')).rejects.toThrow(
      lock.LockUnavailableError,
    )

    // alfa foi adquirido antes de falhar em beta -- deve ter sido liberado no finally.
    const alfaRow = await readLockRow('alfa')
    expect(alfaRow?.lockedBy).toBeNull()
    // zeta nunca chegou a ser adquirido.
    const zetaRow = await readLockRow('zeta')
    expect(zetaRow).toBeUndefined()
    // beta continua com o dono original -- withLocks nao mexeu nele.
    const betaRow = await readLockRow('beta')
    expect(betaRow?.lockedBy).toBe('outroDono#pid555555')
  })
})

describe('recoverWorkerOrphans', () => {
  it('libera locks scheduled:/reconciliation: e marca runs "running" desses gatilhos como failed', async () => {
    await lock.acquireLock('estoque', 'scheduled:worker')
    await lock.acquireLock('preco', 'reconciliation:worker')
    await lock.acquireLock('outro', 'web:manual') // nao deve ser tocado

    await db.insert(schema.syncRuns).values({
      kind: 'stock',
      trigger: 'scheduled',
      status: 'running',
      startedAt: new Date().toISOString(),
    })
    await db.insert(schema.syncRuns).values({
      kind: 'stock',
      trigger: 'manual',
      status: 'running',
      startedAt: new Date().toISOString(),
    })

    const result = await lock.recoverWorkerOrphans()

    expect(result.locks).toBe(2)
    expect(result.runs).toBe(1)

    expect((await readLockRow('estoque'))?.lockedBy).toBeNull()
    expect((await readLockRow('preco'))?.lockedBy).toBeNull()
    expect((await readLockRow('outro'))?.lockedBy).toContain('web:manual') // preservado

    const runs = await db.select().from(schema.syncRuns).all()
    const scheduledRun = runs.find((r) => r.trigger === 'scheduled')
    const manualRun = runs.find((r) => r.trigger === 'manual')
    expect(scheduledRun?.status).toBe('failed')
    expect(manualRun?.status).toBe('running') // trigger manual nao e orfao de worker, preservado
  })
})
