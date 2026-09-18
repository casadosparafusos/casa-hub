import 'server-only'
import { randomUUID } from 'node:crypto'
import { db, schema } from '../db'
import { eq, and, lt, or, isNull, like } from 'drizzle-orm'

// Lock transacional simples via a tabela job_locks -- garante que o worker
// agendado e um disparo manual nunca rodem o mesmo tipo de sincronizacao
// ao mesmo tempo. SQLite serializa escritas por natureza, entao um
// UPDATE condicional (WHERE livre-ou-expirado) e suficiente aqui; nao
// precisa de um lock distribuido de verdade porque so ha um arquivo de
// banco, um servico web e um worker.

// BUG CORRIGIDO (09/09/2026): 30min era baseado na suposicao de que uma sync
// terminava rapido. Isso valia so por acidente, porque o bug de raiz do
// `tipoIdentificador` (ver client.ts / docs/WAKE-API-CONTRATOS.md) fazia
// toda escrita falhar quase instantaneamente. Com o fix aplicado, uma sync
// de estoque no catalogo inteiro passava facilmente dos 30min -- run 206
// ainda rodando aos ~35min. O TTL curto deixava o lock expirar com a run
// original ainda ativa, permitindo uma segunda run concorrente no mesmo
// recurso (run 208 iniciou enquanto 206 seguia rodando). O TTL e so um
// backstop -- em uso normal o `finally` do withLock libera o lock na hora.
const DEFAULT_TTL_MS = 3 * 60 * 60 * 1000 // 3h -- backstop de crash, nao limite de duracao normal

// BUG CORRIGIDO (10/09/2026): o TTL de 3h tinha um efeito colateral serio.
// Um restart do worker (deploy, reboot, crash) no meio de uma run deixava o
// lock gravado com 3h de validade, e o estoque agendado ficava PULADO a
// cada minuto ate o lock expirar -- confirmado ao vivo: run 231 morta pelo
// restart das 09:52, worker logando "pulado (lock em uso)" minuto a minuto.
// Agora cada lock guarda o PID do processo dono (`...#pid1234`). Web e
// worker rodam no mesmo host e com o mesmo usuario, entao da pra checar se
// o dono ainda existe; se nao existir, o lock e roubado na hora. O TTL
// continua valendo como ultima linha de defesa.
const PID_MARKER = '#pid'

// BUG CORRIGIDO (revisão Tech Lead do PR #4, 2026-09-18): `${lockedBy}#pid${pid}`
// nao e unico por aquisicao -- duas chamadas de acquireLock no mesmo processo
// com o mesmo `lockedBy` geram o mesmo token. Se a execucao A passa do TTL e a
// execucao B (mesmo worker/PID) adquire o lock, o `finally` tardio de A ainda
// teria o mesmo token e liberaria o lock que agora pertence a B. Cada
// aquisicao agora carrega um nonce (`randomUUID()`) alem do PID, entao dois
// tokens do mesmo processo/lockedBy nunca colidem.
const LOCK_MARKER = '#lock:'

function ownerTag(lockedBy: string): string {
  return `${lockedBy}${PID_MARKER}${process.pid}${LOCK_MARKER}${randomUUID()}`
}

function ownerPid(lockedBy: string | null): number | null {
  if (!lockedBy) return null
  const i = lockedBy.lastIndexOf(PID_MARKER)
  if (i < 0) return null
  // O PID e sempre os digitos logo apos o marcador -- usar regex em vez de
  // `Number()` direto na sobra, porque a sobra agora inclui o nonce
  // (`123#lock:<uuid>`), que `Number()` nao parseia como inteiro.
  const match = lockedBy.slice(i + PID_MARKER.length).match(/^(\d+)/)
  if (!match) return null
  const pid = Number(match[1])
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** true se o processo existe. EPERM = existe mas e de outro usuario -> vivo. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class LockUnavailableError extends Error {}

// FASE D-PRE §7: acquireLock devolve o token que gravou (tag = lockedBy+pid+
// nonce, unico por acquisicao -- ver LOCK_MARKER acima) e releaseLock exige
// esse token pra limpar. Sem isso,
// um TTL expirado com o dono original ainda vivo (rodando mais que o
// backstop de 3h) deixava outro processo adquirir o lock (result.changes>0
// no UPDATE condicional por expiresAt), e depois o dono original terminava
// e chamava releaseLock(resource) sem condicao nenhuma -- limpando o lock do
// novo dono legitimo enquanto ele ainda estava rodando.
export async function acquireLock(resource: string, lockedBy: string, ttlMs = DEFAULT_TTL_MS): Promise<string> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
  const nowIso = now.toISOString()
  const tag = ownerTag(lockedBy)

  // garante que a linha existe
  await db.insert(schema.jobLocks).values({ resource }).onConflictDoNothing()

  const result = await db
    .update(schema.jobLocks)
    .set({ lockedAt: nowIso, lockedBy: tag, expiresAt })
    .where(
      and(
        eq(schema.jobLocks.resource, resource),
        or(isNull(schema.jobLocks.expiresAt), lt(schema.jobLocks.expiresAt, nowIso)),
      ),
    )
    .run()
  if (result.changes > 0) return tag

  // Ocupado -- mas o dono ainda esta vivo?
  const current = await db.select().from(schema.jobLocks).where(eq(schema.jobLocks.resource, resource)).get()
  const pid = ownerPid(current?.lockedBy ?? null)
  if (current?.lockedBy && pid !== null && pid !== process.pid && !isProcessAlive(pid)) {
    // Condicional no lockedBy antigo: se outro processo roubou primeiro, changes=0.
    const stolen = await db
      .update(schema.jobLocks)
      .set({ lockedAt: nowIso, lockedBy: tag, expiresAt })
      .where(and(eq(schema.jobLocks.resource, resource), eq(schema.jobLocks.lockedBy, current.lockedBy)))
      .run()
    if (stolen.changes > 0) {
      console.warn(`[lock] '${resource}' estava preso por processo morto (${current.lockedBy}) -- liberado`)
      return tag
    }
  }

  throw new LockUnavailableError(`Recurso '${resource}' ja esta em uso por outra sincronizacao em andamento.`)
}

/** So libera se `token` (devolvido por acquireLock) ainda for o dono atual do lock. */
export async function releaseLock(resource: string, token: string): Promise<void> {
  await db
    .update(schema.jobLocks)
    .set({ lockedAt: null, lockedBy: null, expiresAt: null })
    .where(and(eq(schema.jobLocks.resource, resource), eq(schema.jobLocks.lockedBy, token)))
    .run()
}

/**
 * Roda fn com TODOS os locks adquiridos, liberando mesmo se fn lancar.
 * Adquire em ordem alfabetica (evita deadlock entre dois chamadores) e, se
 * algum falhar no meio, devolve os que ja tinha pego.
 */
export async function withLocks<T>(resources: string[], lockedBy: string, fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(resources)].sort()
  const held: Array<{ resource: string; token: string }> = []
  try {
    for (const r of ordered) {
      const token = await acquireLock(r, lockedBy)
      held.push({ resource: r, token })
    }
    return await fn()
  } finally {
    for (const { resource, token } of held.reverse()) await releaseLock(resource, token)
  }
}

/** Roda fn com o lock adquirido, liberando mesmo se fn lancar. */
export async function withLock<T>(resource: string, lockedBy: string, fn: () => Promise<T>): Promise<T> {
  return withLocks([resource], lockedBy, fn)
}

/**
 * Chamado UMA vez quando o worker sobe. So o worker roda syncs 'scheduled'
 * e 'reconciliation', e o systemd garante uma unica instancia dele -- entao
 * qualquer lock desses donos, ou run desses gatilhos ainda marcada
 * 'running', e sobra de um processo anterior que morreu (restart/reboot).
 * Libera os locks e fecha as runs como 'failed' com o motivo, pra que nao
 * fiquem "Em andamento" pra sempre na tela.
 */
export async function recoverWorkerOrphans(): Promise<{ locks: number; runs: number }> {
  const nowIso = new Date().toISOString()
  let locks = 0
  for (const prefix of ['scheduled:', 'reconciliation:']) {
    const r = await db
      .update(schema.jobLocks)
      .set({ lockedAt: null, lockedBy: null, expiresAt: null })
      .where(like(schema.jobLocks.lockedBy, `${prefix}%`))
      .run()
    locks += r.changes
  }
  const runs = await db
    .update(schema.syncRuns)
    .set({
      status: 'failed',
      finishedAt: nowIso,
      errorSummary: 'Interrompida: o processo do worker foi reiniciado durante a execução.',
    })
    .where(
      and(
        eq(schema.syncRuns.status, 'running'),
        or(eq(schema.syncRuns.trigger, 'scheduled'), eq(schema.syncRuns.trigger, 'reconciliation')),
      ),
    )
    .run()
  return { locks, runs: runs.changes }
}
