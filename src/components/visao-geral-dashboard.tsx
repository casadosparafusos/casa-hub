import { desc } from 'drizzle-orm'
import clsx from 'clsx'
import { db, schema } from '@/lib/db'
import { checkRequiredUnconfirmed } from '@/lib/settings'
import { SyncTriggerPanel } from '@/components/sync-trigger-panel'
import { formatDateTime, syncKindLabel, syncTriggerLabel, syncRunStatusLabel } from '@/lib/format'

// Conteudo da Visao Geral, extraido de src/app/(app)/page.tsx (04/09/2026).
// O motivo: a raiz "/" de um route group tem um bug conhecido do Next.js 15
// (InvariantError "Expected clientReferenceManifest to be defined" em
// producao/`next start`, so nessa rota especifica -- ver
// https://github.com/vercel/next.js/pull/73606 e discussao #51701). As
// demais paginas do grupo (app), por serem segmentos nomeados e nao a raiz
// do grupo, nao sao afetadas. Fix: "/" agora e um page.tsx literal em
// src/app/ (fora do grupo), que so importa este componente -- ver
// src/app/page.tsx.
export async function VisaoGeralDashboard() {
  const [{ missing }, recentRuns, productCount] = await Promise.all([
    checkRequiredUnconfirmed(),
    db.select().from(schema.syncRuns).orderBy(desc(schema.syncRuns.startedAt)).limit(8),
    db.select().from(schema.managedProducts),
  ])

  const activeCount = productCount.filter((p) => p.active).length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--texto)]">Visão Geral</h1>
        <p className="text-sm text-[var(--texto-suave)]">
          Sincronização de preço e estoque do ERP (CISS/PODER) para o Wake Commerce — escopo fixadores/parafusos.
        </p>
      </div>

      {missing.length > 0 && (
        <div className="section section--pad border-amber-200 bg-amber-50 text-sm text-amber-700">
          <p className="font-medium">Configuração incompleta -- sincronização real bloqueada</p>
          <p className="mt-1">
            Faltam confirmar: <span className="font-mono">{missing.join(', ')}</span>. Só é possível rodar em modo
            dry-run até preencher em{' '}
            <a href="/configuracoes" className="underline">
              Configurações
            </a>
            .
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Produtos na whitelist" value={String(productCount.length)} sub={`${activeCount} ativos`} />
        <StatCard
          label="Última execução"
          value={recentRuns[0] ? syncRunStatusLabel(recentRuns[0].status) : '—'}
          sub={recentRuns[0] ? formatDateTime(recentRuns[0].startedAt) : 'nenhuma ainda'}
        />
        <StatCard label="Modo" value={missing.length > 0 ? 'Somente simulação' : 'Pronto pra produção'} accent={missing.length > 0 ? 'warn' : 'good'} />
      </div>

      <SyncTriggerPanel blockedReal={missing.length > 0} />

      <div>
        <h2 className="mb-2 text-sm font-medium text-[var(--texto)]">Últimas execuções</h2>
        <div className="section overflow-x-auto">
          <table className="data-table w-full text-sm">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left">Início</th>
                <th className="px-3 py-2 text-left">Tipo</th>
                <th className="px-3 py-2 text-left">Origem</th>
                <th className="px-3 py-2 text-left">Simulação</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Alterados</th>
                <th className="px-3 py-2 text-right">Aplicados</th>
                <th className="px-3 py-2 text-right">Falhas</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-center text-[var(--texto-suave)]">
                    Nenhuma execução ainda.
                  </td>
                </tr>
              )}
              {recentRuns.map((run) => (
                <tr key={run.id} className="border-b border-[var(--borda)]">
                  <td className="px-3 py-2">{formatDateTime(run.startedAt)}</td>
                  <td className="px-3 py-2">{syncKindLabel(run.kind)}</td>
                  <td className="px-3 py-2">{syncTriggerLabel(run.trigger)}</td>
                  <td className="px-3 py-2">{run.dryRun ? 'sim' : 'não'}</td>
                  <td className="px-3 py-2">{syncRunStatusLabel(run.status)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{run.changedProducts}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{run.appliedProducts}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{run.failedProducts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'good' | 'warn' }) {
  return (
    <div className="section section--pad">
      <p className="text-[11px] font-bold uppercase tracking-[0.04em] text-[var(--texto-suave)]">{label}</p>
      <p
        className={clsx(
          'mt-1 text-2xl font-bold tracking-tight',
          accent === 'good' && 'text-emerald-700',
          accent === 'warn' && 'text-amber-700',
          !accent && 'text-[var(--texto)]',
        )}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-[var(--texto-suave)]">{sub}</p>}
    </div>
  )
}
