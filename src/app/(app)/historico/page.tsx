import { db, schema } from '@/lib/db'
import { desc, eq } from 'drizzle-orm'
import {
  formatDateTime,
  syncKindLabel,
  syncTriggerLabel,
  syncRunStatusLabel,
  syncItemStatusLabel,
  syncFieldLabel,
} from '@/lib/format'

export const dynamic = 'force-dynamic'

export default async function HistoricoPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  // No Next 15, searchParams chega como Promise (dynamic APIs) -- sempre await.
  const params = await searchParams
  const runs = await db.select().from(schema.syncRuns).orderBy(desc(schema.syncRuns.startedAt)).limit(50)
  const selectedRunId = params.run ? Number(params.run) : runs[0]?.id

  const items = selectedRunId
    ? await db
        .select({
          field: schema.syncRunItems.field,
          status: schema.syncRunItems.status,
          sourceOldValue: schema.syncRunItems.sourceOldValue,
          sourceNewValue: schema.syncRunItems.sourceNewValue,
          targetOldValue: schema.syncRunItems.targetOldValue,
          targetNewValue: schema.syncRunItems.targetNewValue,
          errorMessage: schema.syncRunItems.errorMessage,
          wakeSku: schema.managedProducts.wakeSku,
        })
        .from(schema.syncRunItems)
        .innerJoin(schema.managedProducts, eq(schema.managedProducts.id, schema.syncRunItems.managedProductId))
        .where(eq(schema.syncRunItems.syncRunId, selectedRunId))
        .limit(500)
    : []

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-[var(--texto)]">Histórico</h1>
        <p className="text-sm text-[var(--texto-suave)]">Trilha de auditoria completa: toda mudança de preço/estoque tem origem, destino e status registrados.</p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        <div className="section overflow-y-auto">
          {runs.map((run) => (
            <a
              key={run.id}
              href={`/historico?run=${run.id}`}
              className={`block border-b border-[var(--borda)] px-3 py-2.5 text-sm transition-colors last:border-0 hover:bg-[var(--superficie-hover)] ${
                run.id === selectedRunId ? 'bg-[var(--marca-lavada)]' : ''
              }`}
            >
              <p className="font-semibold text-[var(--texto)]">
                #{run.id} · {syncKindLabel(run.kind)} · {syncTriggerLabel(run.trigger)}
              </p>
              <p className="text-xs text-[var(--texto-suave)]">
                {formatDateTime(run.startedAt)} — {syncRunStatusLabel(run.status)}
                {run.dryRun ? ' (simulação)' : ''}
              </p>
            </a>
          ))}
          {runs.length === 0 && <p className="p-3 text-sm text-[var(--texto-suave)]">Nenhuma execução ainda.</p>}
        </div>

        <div className="section overflow-x-auto">
          <table className="data-table w-full text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left">SKU</th>
                <th className="px-3 py-2 text-left">Campo</th>
                <th className="px-3 py-2 text-right">Origem (antes → depois)</th>
                <th className="px-3 py-2 text-right">Destino (antes → depois)</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-[var(--texto-suave)]">
                    Selecione uma execução.
                  </td>
                </tr>
              )}
              {items.map((item, i) => (
                <tr key={i} className="border-b border-[var(--borda)]">
                  <td className="px-3 py-2 font-mono text-xs">{item.wakeSku}</td>
                  <td className="px-3 py-2">{syncFieldLabel(item.field)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--texto-suave)]">
                    {item.sourceOldValue ?? '—'} → {item.sourceNewValue ?? '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--texto-suave)]">
                    {item.targetOldValue ?? '—'} → {item.targetNewValue ?? '—'}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={item.status} />
                    {item.errorMessage && (
                      <p className={`mt-0.5 text-xs ${item.status === 'failed' ? 'text-red-600' : 'text-[var(--texto-suave)]'}`}>{item.errorMessage}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    applied: 'bg-emerald-50 text-emerald-700',
    planned: 'bg-sky-50 text-sky-800',
    no_change: 'bg-slate-100 text-slate-600',
    failed: 'bg-red-50 text-red-700',
    skipped: 'bg-amber-50 text-amber-700',
  }
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${styles[status] ?? 'bg-slate-100 text-slate-600'}`}>
      {syncItemStatusLabel(status)}
    </span>
  )
}
