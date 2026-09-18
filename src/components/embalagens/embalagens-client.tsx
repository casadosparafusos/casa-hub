'use client'

import { useMemo, useState } from 'react'
import { formatDateTime } from '@/lib/format'
import type {
  ConfigWithProduct,
  ImportApplyResult,
  ImportValidationResult,
  PendingProduct,
  ValidatedImportRow,
} from '@/lib/measured-packages/types'

type Filter = 'ALL' | 'KG' | 'MT' | 'PENDING' | 'INACTIVE'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'ALL', label: 'Todos' },
  { value: 'KG', label: 'KG' },
  { value: 'MT', label: 'MT' },
  { value: 'PENDING', label: 'Pendentes' },
  { value: 'INACTIVE', label: 'Inativos' },
]

// Aceita virgula decimal na digitacao manual (mesma tolerancia do parser de
// planilha, FASE E secao 6) sem reimplementar a validacao -- so normaliza
// pra numero antes de mandar pro service, que revalida tudo de novo.
function parseQuantityInput(raw: string): number {
  const trimmed = raw.trim()
  const normalized = trimmed.includes(',') && !trimmed.includes('.') ? trimmed.replace(',', '.') : trimmed
  return Number(normalized)
}

function StatusBadge({ children, tone }: { children: React.ReactNode; tone: 'ok' | 'warn' | 'error' | 'muted' }) {
  const toneClass = {
    ok: 'bg-emerald-50 text-emerald-700',
    warn: 'bg-amber-50 text-amber-700',
    error: 'bg-rose-50 text-rose-700',
    muted: 'bg-slate-100 text-slate-600',
  }[tone]
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${toneClass}`}>{children}</span>
}

interface ManualFormState {
  sku: string
  skuLocked: boolean
  quantity: string
  configId: number | null
}

export function EmbalagensClient({
  initialConfigs,
  initialPending,
}: {
  initialConfigs: ConfigWithProduct[]
  initialPending: PendingProduct[]
}) {
  const [configs, setConfigs] = useState(initialConfigs)
  const [pending, setPending] = useState(initialPending)
  const [filter, setFilter] = useState<Filter>('ALL')
  const [search, setSearch] = useState('')

  const [manualForm, setManualForm] = useState<ManualFormState | null>(null)
  const [manualBusy, setManualBusy] = useState(false)
  const [manualError, setManualError] = useState<string | null>(null)

  const [deactivateTarget, setDeactivateTarget] = useState<ConfigWithProduct | null>(null)
  const [deactivateBusy, setDeactivateBusy] = useState(false)
  const [rowBusyId, setRowBusyId] = useState<number | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)

  const [importOpen, setImportOpen] = useState(false)

  const kgCount = configs.filter((c) => c.active && c.sourceUnit === 'KG').length
  const mtCount = configs.filter((c) => c.active && c.sourceUnit === 'MT').length

  async function refetch() {
    const res = await fetch('/api/embalagens')
    if (!res.ok) return
    const data = await res.json()
    setConfigs(data.configs)
    setPending(data.pending)
  }

  const searchLower = search.trim().toLowerCase()
  function matchesSearch(sku: string, name: string | null) {
    if (!searchLower) return true
    return sku.toLowerCase().includes(searchLower) || (name ?? '').toLowerCase().includes(searchLower)
  }

  const visibleConfigs = useMemo(() => {
    return configs
      .filter((c) => {
        if (filter === 'PENDING') return false
        if (filter === 'INACTIVE') return !c.active
        if (filter === 'KG') return c.active && c.sourceUnit === 'KG'
        if (filter === 'MT') return c.active && c.sourceUnit === 'MT'
        return c.active
      })
      .filter((c) => matchesSearch(c.wakeSku, c.wakeProductName))
  }, [configs, filter, searchLower])

  const visiblePending = useMemo(() => {
    if (filter !== 'ALL' && filter !== 'PENDING') return []
    return pending.filter((p) => matchesSearch(p.wakeSku, p.wakeProductName))
  }, [pending, filter, searchLower])

  function openCreateForm() {
    setManualError(null)
    setManualForm({ sku: '', skuLocked: false, quantity: '', configId: null })
  }

  function openEditForm(config: ConfigWithProduct) {
    setManualError(null)
    setManualForm({ sku: config.wakeSku, skuLocked: true, quantity: String(config.quantityPerSaleUnit), configId: config.id })
  }

  function openConfigureFromPending(p: PendingProduct) {
    setManualError(null)
    setManualForm({ sku: p.wakeSku, skuLocked: true, quantity: '', configId: null })
  }

  async function submitManualForm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!manualForm) return
    const quantity = parseQuantityInput(manualForm.quantity)
    setManualBusy(true)
    setManualError(null)
    try {
      const res = await fetch('/api/embalagens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: manualForm.sku.trim(), quantity }),
      })
      const data = await res.json()
      if (!res.ok) {
        setManualError(data.error ?? 'Não foi possível salvar.')
        return
      }
      setManualForm(null)
      await refetch()
    } catch (err) {
      setManualError(err instanceof Error ? err.message : String(err))
    } finally {
      setManualBusy(false)
    }
  }

  async function confirmDeactivate() {
    if (!deactivateTarget) return
    setDeactivateBusy(true)
    setRowError(null)
    try {
      const res = await fetch(`/api/embalagens/${deactivateTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deactivate' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setRowError(data.error ?? 'Não foi possível desativar.')
        return
      }
      setDeactivateTarget(null)
      await refetch()
    } catch (err) {
      setRowError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeactivateBusy(false)
    }
  }

  async function reactivate(config: ConfigWithProduct) {
    setRowBusyId(config.id)
    setRowError(null)
    try {
      const res = await fetch(`/api/embalagens/${config.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reactivate' }),
      })
      const data = await res.json()
      if (!res.ok) {
        setRowError(data.error ?? 'Não foi possível reativar.')
        return
      }
      await refetch()
    } catch (err) {
      setRowError(err instanceof Error ? err.message : String(err))
    } finally {
      setRowBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="section section--pad">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--texto-suave)]">KG configurados</p>
          <p className="mt-1 text-2xl font-bold text-[var(--texto)]">{kgCount}</p>
        </div>
        <div className="section section--pad">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--texto-suave)]">MT configurados</p>
          <p className="mt-1 text-2xl font-bold text-[var(--texto)]">{mtCount}</p>
        </div>
        <div className="section section--pad">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--texto-suave)]">Pendentes de configuração</p>
          <p className="mt-1 text-2xl font-bold text-[var(--texto)]">{pending.length}</p>
        </div>
      </div>

      <div className="section section--pad">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={openCreateForm}
              className="rounded-full bg-[var(--marca)] px-4 py-1.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[var(--marca-escura)]"
            >
              + Configurar produto
            </button>
            <button
              type="button"
              onClick={() => setImportOpen(true)}
              className="rounded-full border border-[var(--borda)] px-4 py-1.5 text-sm font-semibold text-[var(--texto)] transition-colors hover:bg-[var(--fundo-suave)]"
            >
              Importar planilha
            </button>
            <a
              href="/api/embalagens/template"
              download
              className="rounded-full border border-[var(--borda)] px-4 py-1.5 text-sm font-semibold text-[var(--texto)] transition-colors hover:bg-[var(--fundo-suave)]"
            >
              Baixar modelo
            </a>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por SKU ou nome..."
            className="w-full max-w-xs rounded-full border border-[var(--borda)] px-4 py-1.5 text-sm text-[var(--texto)]"
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              className={
                filter === f.value
                  ? 'rounded-full bg-[var(--marca)] px-3.5 py-1 text-xs font-bold text-white'
                  : 'rounded-full bg-[var(--fundo-suave)] px-3.5 py-1 text-xs font-semibold text-[var(--texto-suave)] transition-colors hover:bg-[var(--borda)]'
              }
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {rowError && (
        <div className="section section--pad border border-rose-200 bg-rose-50 text-sm text-rose-700">{rowError}</div>
      )}

      <div className="section overflow-x-auto">
        <table className="data-table w-full text-sm">
          <thead>
            <tr>
              <th className="px-3 py-2 text-left">SKU</th>
              <th className="px-3 py-2 text-left">Produto</th>
              <th className="px-3 py-2 text-left">ID CISS</th>
              <th className="px-3 py-2 text-left">UNIT CISS</th>
              <th className="px-3 py-2 text-left">Quantidade por unidade vendável</th>
              <th className="px-3 py-2 text-left">Status</th>
              <th className="px-3 py-2 text-left">Atualizado em</th>
              <th className="px-3 py-2 text-left">Atualizado por</th>
              <th className="px-3 py-2 text-left">Ações</th>
            </tr>
          </thead>
          <tbody>
            {visibleConfigs.length === 0 && visiblePending.length === 0 && (
              <tr>
                <td colSpan={9} className="px-3 py-4 text-center text-[var(--texto-suave)]">
                  Nenhum item encontrado para este filtro.
                </td>
              </tr>
            )}
            {visibleConfigs.map((c) => (
              <tr key={`config-${c.id}`} className="border-b border-[var(--borda)]">
                <td className="px-3 py-2 font-mono text-xs text-[var(--texto-suave)]">{c.wakeSku}</td>
                <td className="px-3 py-2">{c.wakeProductName ?? <span className="text-[var(--texto-suave)]">—</span>}</td>
                <td className="px-3 py-2 font-mono text-xs text-[var(--texto-suave)]">{c.cissProductId}</td>
                <td className="px-3 py-2">{c.sourceUnit}</td>
                <td className="px-3 py-2 tabular-nums">{c.quantityPerSaleUnit}</td>
                <td className="px-3 py-2">
                  {c.active ? <StatusBadge tone="ok">ativo</StatusBadge> : <StatusBadge tone="muted">inativo</StatusBadge>}
                </td>
                <td className="px-3 py-2 text-[var(--texto-suave)]">{formatDateTime(c.updatedAt)}</td>
                <td className="px-3 py-2 text-[var(--texto-suave)]">{c.updatedBy ?? '—'}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-2">
                    {c.active ? (
                      <>
                        <button
                          type="button"
                          onClick={() => openEditForm(c)}
                          className="rounded-full border border-[var(--borda)] px-3 py-1 text-xs font-semibold text-[var(--texto)] transition-colors hover:bg-[var(--fundo-suave)]"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeactivateTarget(c)}
                          className="rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-50"
                        >
                          Desativar
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={rowBusyId === c.id}
                        onClick={() => reactivate(c)}
                        className="rounded-full border border-emerald-200 px-3 py-1 text-xs font-semibold text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50"
                      >
                        {rowBusyId === c.id ? 'Reativando…' : 'Reativar'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {visiblePending.map((p) => (
              <tr key={`pending-${p.managedProductId}`} className="border-b border-[var(--borda)]">
                <td className="px-3 py-2 font-mono text-xs text-[var(--texto-suave)]">{p.wakeSku}</td>
                <td className="px-3 py-2">{p.wakeProductName ?? <span className="text-[var(--texto-suave)]">—</span>}</td>
                <td className="px-3 py-2 font-mono text-xs text-[var(--texto-suave)]">{p.cissProductId}</td>
                <td className="px-3 py-2">{p.unitNormalized}</td>
                <td className="px-3 py-2 text-[var(--texto-suave)]">—</td>
                <td className="px-3 py-2">
                  <StatusBadge tone="warn">pendente</StatusBadge>
                </td>
                <td className="px-3 py-2 text-[var(--texto-suave)]">—</td>
                <td className="px-3 py-2 text-[var(--texto-suave)]">—</td>
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => openConfigureFromPending(p)}
                    className="rounded-full bg-[var(--marca)] px-3 py-1 text-xs font-bold text-white transition-colors hover:bg-[var(--marca-escura)]"
                  >
                    Configurar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {manualForm && (
        <ManualFormModal
          state={manualForm}
          busy={manualBusy}
          error={manualError}
          onClose={() => setManualForm(null)}
          onChangeSku={(sku) => setManualForm((f) => (f ? { ...f, sku } : f))}
          onChangeQuantity={(quantity) => setManualForm((f) => (f ? { ...f, quantity } : f))}
          onSubmit={submitManualForm}
        />
      )}

      {deactivateTarget && (
        <ConfirmModal
          title="Desativar configuração"
          busy={deactivateBusy}
          onCancel={() => setDeactivateTarget(null)}
          onConfirm={confirmDeactivate}
          confirmLabel="Desativar"
        >
          <p>
            Desativar a configuração de <strong>{deactivateTarget.wakeSku}</strong> ({deactivateTarget.wakeProductName ?? 'sem nome'})? O
            motor voltará a exigir configuração para este produto até que seja reativado ou reconfigurado.
          </p>
        </ConfirmModal>
      )}

      {importOpen && (
        <ImportWizard
          onClose={() => setImportOpen(false)}
          onApplied={async () => {
            await refetch()
          }}
        />
      )}
    </div>
  )
}

function ManualFormModal({
  state,
  busy,
  error,
  onClose,
  onChangeSku,
  onChangeQuantity,
  onSubmit,
}: {
  state: ManualFormState
  busy: boolean
  error: string | null
  onClose: () => void
  onChangeSku: (v: string) => void
  onChangeQuantity: (v: string) => void
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl">
        <h2 className="mb-1 text-base font-bold text-[var(--texto)]">
          {state.configId ? 'Editar configuração' : 'Configurar produto'}
        </h2>
        <p className="mb-4 text-xs text-[var(--texto-suave)]">
          A UNIT (KG ou MT) é lida automaticamente do CISS -- não é preciso informar aqui.
        </p>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold text-[var(--texto-suave)]">SKU (Wake)</label>
            <input
              type="text"
              value={state.sku}
              onChange={(e) => onChangeSku(e.target.value)}
              disabled={state.skuLocked}
              required
              className="w-full rounded-md border border-[var(--borda)] px-3 py-1.5 text-sm text-[var(--texto)] disabled:bg-[var(--fundo-suave)] disabled:text-[var(--texto-suave)]"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-[var(--texto-suave)]">Quantidade por unidade vendável</label>
            <input
              type="text"
              inputMode="decimal"
              value={state.quantity}
              onChange={(e) => onChangeQuantity(e.target.value)}
              placeholder="Ex.: 18 ou 12,5"
              required
              className="w-full rounded-md border border-[var(--borda)] px-3 py-1.5 text-sm text-[var(--texto)]"
            />
          </div>
          {error && <p className="text-sm text-rose-700">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-full border border-[var(--borda)] px-4 py-1.5 text-sm font-semibold text-[var(--texto)] disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-full bg-[var(--marca)] px-4 py-1.5 text-sm font-bold text-white shadow-sm hover:bg-[var(--marca-escura)] disabled:opacity-50"
            >
              {busy ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function ConfirmModal({
  title,
  children,
  busy,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string
  children: React.ReactNode
  busy: boolean
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl">
        <h2 className="mb-3 text-base font-bold text-[var(--texto)]">{title}</h2>
        <div className="mb-4 text-sm text-[var(--texto)]">{children}</div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-full border border-[var(--borda)] px-4 py-1.5 text-sm font-semibold text-[var(--texto)] disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-full bg-rose-600 px-4 py-1.5 text-sm font-bold text-white hover:bg-rose-700 disabled:opacity-50"
          >
            {busy ? 'Confirmando…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

type WizardStep = 'select' | 'preview' | 'result'

function ImportWizard({ onClose, onApplied }: { onClose: () => void; onApplied: () => Promise<void> }) {
  const [step, setStep] = useState<WizardStep>('select')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportValidationResult | null>(null)
  const [applyResult, setApplyResult] = useState<ImportApplyResult | null>(null)

  async function runPreview() {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const body = new FormData()
      body.set('file', file)
      const res = await fetch('/api/embalagens/import?mode=preview', { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Não foi possível ler o arquivo.')
        return
      }
      setPreview(data as ImportValidationResult)
      setStep('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function runApply() {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const body = new FormData()
      body.set('file', file)
      const res = await fetch('/api/embalagens/import?mode=apply', { method: 'POST', body })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Não foi possível aplicar a importação.')
        return
      }
      setApplyResult(data as ImportApplyResult)
      setStep('result')
      await onApplied()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const statusTone = (status: ValidatedImportRow['status']): 'ok' | 'warn' | 'error' =>
    status === 'valid' ? 'ok' : status === 'warning' ? 'warn' : 'error'

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white p-5 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <h2 className="text-base font-bold text-[var(--texto)]">Importar planilha (KG/MT)</h2>
          <button type="button" onClick={onClose} className="text-sm text-[var(--texto-suave)] hover:text-[var(--texto)]">
            Fechar
          </button>
        </div>

        {step === 'select' && (
          <div className="space-y-3">
            <p className="text-sm text-[var(--texto-suave)]">
              Aceita .xlsx ou .csv, colunas SKU / NOME / QT KG ou QT MT (conforme o formato). A UNIT é sempre
              confirmada ao vivo no CISS -- a coluna do arquivo só informa a quantidade.
            </p>
            <input
              type="file"
              accept=".xlsx,.csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-sm text-[var(--texto)]"
            />
            {error && <p className="text-sm text-rose-700">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full border border-[var(--borda)] px-4 py-1.5 text-sm font-semibold text-[var(--texto)]"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={!file || busy}
                onClick={runPreview}
                className="rounded-full bg-[var(--marca)] px-4 py-1.5 text-sm font-bold text-white shadow-sm hover:bg-[var(--marca-escura)] disabled:opacity-50"
              >
                {busy ? 'Lendo…' : 'Pré-visualizar'}
              </button>
            </div>
          </div>
        )}

        {step === 'preview' && preview && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3 text-sm">
              <StatusBadge tone="ok">{preview.createCount} novos</StatusBadge>
              <StatusBadge tone="warn">{preview.updateCount} atualizações</StatusBadge>
              <StatusBadge tone="muted">{preview.noopCount} sem mudança</StatusBadge>
              <StatusBadge tone="error">{preview.errorCount} com erro</StatusBadge>
            </div>
            <div className="max-h-96 overflow-y-auto rounded border border-[var(--borda)]">
              <table className="data-table w-full text-xs">
                <thead>
                  <tr>
                    <th className="px-2 py-1.5 text-left">Linha</th>
                    <th className="px-2 py-1.5 text-left">SKU</th>
                    <th className="px-2 py-1.5 text-left">Produto</th>
                    <th className="px-2 py-1.5 text-left">UNIT CISS</th>
                    <th className="px-2 py-1.5 text-left">Quantidade</th>
                    <th className="px-2 py-1.5 text-left">Ação</th>
                    <th className="px-2 py-1.5 text-left">Mensagem</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={`${r.sheet}:${r.line}:${r.sku}`} className="border-b border-[var(--borda)]">
                      <td className="px-2 py-1.5">{r.sheet !== 'CSV' ? `${r.sheet}!${r.line}` : r.line}</td>
                      <td className="px-2 py-1.5 font-mono">{r.sku}</td>
                      <td className="px-2 py-1.5">{r.managedProductName ?? r.nameFromFile ?? '—'}</td>
                      <td className="px-2 py-1.5">{r.detectedUnit ?? '—'}</td>
                      <td className="px-2 py-1.5 tabular-nums">{r.quantityPerSaleUnit ?? '—'}</td>
                      <td className="px-2 py-1.5">
                        <StatusBadge tone={statusTone(r.status)}>{r.action}</StatusBadge>
                      </td>
                      <td className="px-2 py-1.5 text-[var(--texto-suave)]">{r.message ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {error && <p className="text-sm text-rose-700">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setStep('select')}
                disabled={busy}
                className="rounded-full border border-[var(--borda)] px-4 py-1.5 text-sm font-semibold text-[var(--texto)] disabled:opacity-50"
              >
                Voltar
              </button>
              <button
                type="button"
                disabled={busy || preview.createCount + preview.updateCount === 0}
                onClick={runApply}
                className="rounded-full bg-[var(--marca)] px-4 py-1.5 text-sm font-bold text-white shadow-sm hover:bg-[var(--marca-escura)] disabled:opacity-50"
              >
                {busy ? 'Aplicando…' : `Aplicar ${preview.createCount + preview.updateCount} alterações`}
              </button>
            </div>
          </div>
        )}

        {step === 'result' && applyResult && (
          <div className="space-y-3">
            <p className="text-sm font-semibold text-[var(--texto)]">
              {applyResult.status === 'success' && 'Importação concluída com sucesso.'}
              {applyResult.status === 'partial' && 'Importação concluída parcialmente -- algumas linhas tiveram erro.'}
              {applyResult.status === 'failed' && 'Não foi possível aplicar a importação.'}
            </p>
            <p className="text-sm text-[var(--texto-suave)]">
              {applyResult.appliedCount} linha(s) aplicada(s) de {applyResult.totalRows} lidas ({applyResult.errorCount} com
              erro).
            </p>
            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-full bg-[var(--marca)] px-4 py-1.5 text-sm font-bold text-white shadow-sm hover:bg-[var(--marca-escura)]"
              >
                Concluir
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
