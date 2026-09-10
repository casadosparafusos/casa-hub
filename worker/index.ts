import { and, desc, eq, inArray } from 'drizzle-orm'
import { runSync, type SyncKind } from '../src/lib/sync/engine'
import { LockUnavailableError, recoverWorkerOrphans } from '../src/lib/sync/lock'
import { rules } from '../src/lib/settings'
import { db, schema } from '../src/lib/db'

// -----------------------------------------------------------------------
// Processo de background independente do processo web -- roda como
// systemd service proprio (deploy/erp-wake-worker.service), NAO depende
// de browser/setInterval/ciclo de requisicao. Chama o mesmo motor
// (runSync) que a rota /api/sync usa pro disparo manual, entao nao ha
// logica de negocio duplicada entre os dois caminhos.
//
// Agenda (pedido do usuario em 08/09/2026, ver [[correcao-preco-unitario-divisao-cento]]):
//   - estoque: de STOCK_SYNC_INTERVAL_MINUTES em STOCK_SYNC_INTERVAL_MINUTES
//     (default 1min) -- estoque muda o dia todo por venda, precisa de perto
//     do real time.
//   - preco: de PRICE_SYNC_INTERVAL_HOURS em PRICE_SYNC_INTERVAL_HOURS
//     (default 24h) -- custo do ERP e muito mais estavel, nao precisa de
//     alta frequencia. Os dois sao configuraveis em Configuracoes.
//   - uma vez por dia, no horario configurado (default 03:00), roda
//     'both' com trigger='reconciliation' -- mesma logica de diff, so
//     serve pra pegar drift manual (alteracao feita direto no admin do
//     Wake) e corrigir.
//
// O intervalo de cada kind e calculado a partir do ULTIMO RUN AGENDADO
// gravado em sync_runs (nao um contador em memoria) -- o servidor desliga
// fisicamente todo dia (~18h-08h, ver comentario do Portal em
// /opt/portal/portal.service) e o processo reinicia do zero, entao um
// contador em memoria perderia o histórico e ou re-disparia tudo de
// imediato ou esperaria o intervalo inteiro de novo sem necessidade.
// Consultando o banco, o worker sempre sabe ha quanto tempo rodou de
// verdade, mesmo depois de um restart.
// -----------------------------------------------------------------------

const CHECK_INTERVAL_MS = 60_000 // verifica o relogio a cada minuto -- barato, e o menor intervalo configuravel (estoque) e de 1min
let lastReconciliationDateKey: string | null = null

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** Ultimo run agendado (trigger='scheduled', nao dry-run) que cobriu esse kind -- 'both' conta pros dois. */
async function lastScheduledRunAt(kind: 'price' | 'stock'): Promise<Date | null> {
  const row = await db
    .select({ finishedAt: schema.syncRuns.finishedAt })
    .from(schema.syncRuns)
    .where(
      and(
        inArray(schema.syncRuns.kind, [kind, 'both']),
        eq(schema.syncRuns.trigger, 'scheduled'),
        eq(schema.syncRuns.dryRun, false),
      ),
    )
    .orderBy(desc(schema.syncRuns.id))
    .limit(1)
    .get()
  if (!row?.finishedAt) return null
  return new Date(row.finishedAt)
}

async function runOnce(kind: SyncKind, trigger: 'scheduled' | 'reconciliation') {
  console.log(`[worker] iniciando sync kind=${kind} trigger=${trigger} dryRun=false`)
  try {
    const result = await runSync({ kind, trigger, dryRun: false })
    console.log(`[worker] concluido: run #${result.syncRunId} status=${result.status} mudancas=${result.changedProducts} aplicados=${result.appliedProducts} falhas=${result.failedProducts}`)
  } catch (err) {
    if (err instanceof LockUnavailableError) {
      console.warn(`[worker] pulado (lock em uso): ${err.message}`)
      return
    }
    console.error(`[worker] falhou: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function tick() {
  const now = new Date()

  const stockIntervalMs = (await rules.stockSyncIntervalMinutes()) * 60_000
  const lastStock = await lastScheduledRunAt('stock')
  if (!lastStock || now.getTime() - lastStock.getTime() >= stockIntervalMs) {
    await runOnce('stock', 'scheduled')
  }

  const priceIntervalMs = (await rules.priceSyncIntervalHours()) * 3_600_000
  const lastPrice = await lastScheduledRunAt('price')
  if (!lastPrice || now.getTime() - lastPrice.getTime() >= priceIntervalMs) {
    await runOnce('price', 'scheduled')
  }

  const reconciliationHour = await rules.reconciliationHourLocal()
  if (now.getHours() === reconciliationHour && now.getMinutes() === 0) {
    const key = dateKey(now)
    if (key !== lastReconciliationDateKey) {
      lastReconciliationDateKey = key
      await runOnce('both', 'reconciliation')
    }
  }
}

async function start() {
  console.log('[worker] erp-wake worker iniciado -- verificando o relogio a cada 60s')

  // Antes do primeiro tick: limpa o que um worker anterior deixou pela metade
  // (lock preso + run "Em andamento" eterna). Sem isso, um restart no meio
  // de uma run travava o estoque agendado por ate 3h -- ver lock.ts.
  try {
    const { locks, runs } = await recoverWorkerOrphans()
    if (locks || runs) console.warn(`[worker] recuperacao pos-restart: ${locks} lock(s) liberado(s), ${runs} run(s) orfa(s) fechada(s)`)
  } catch (err) {
    console.error('[worker] falha na recuperacao pos-restart', err)
  }

  setInterval(() => {
    tick().catch((err) => console.error('[worker] erro no tick', err))
  }, CHECK_INTERVAL_MS)

  // roda um tick imediato ao subir -- e o proprio mecanismo de catch-up: se o
  // intervalo configurado ja estourou (ex: servidor ficou desligado a noite),
  // o sync agendado dispara na hora, sem esperar o proximo minuto redondo.
  await tick().catch((err) => console.error('[worker] erro no tick inicial', err))
}

start()

process.on('SIGTERM', () => {
  console.log('[worker] SIGTERM recebido, encerrando')
  process.exit(0)
})
