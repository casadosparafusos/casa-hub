'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { syncRunStatusLabel } from '@/lib/format'

// Disparo manual, usando exatamente a mesma API (POST /api/sync) que o
// worker agendado chama internamente -- garante que os dois caminhos
// (manual e agendado) passam pelo mesmo motor (src/lib/sync/engine.ts).

type SyncKind = 'price' | 'stock' | 'both'

export function SyncTriggerPanel({ blockedReal }: { blockedReal: boolean }) {
  const router = useRouter()
  const [kind, setKind] = useState<SyncKind>('both')
  // Começa DESMARCADO (mudado em 10/09/2026). Antes vinha marcado por
  // padrão, o que era uma armadilha: quem clicava "Executar" esperando
  // sincronizar de verdade recebia só uma simulação e nada subia pro Wake,
  // sem nenhum aviso óbvio. A simulação continua disponível -- é útil pra
  // conferir o efeito de uma mudança de regra/configuração antes de mexer
  // na loja ao vivo -- mas agora é uma escolha explícita.
  const [dryRun, setDryRun] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function trigger() {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, dryRun }),
      })
      const data = await res.json()
      if (!res.ok) {
        setResult(`Erro: ${data.error ?? res.statusText}`)
      } else {
        setResult(
          `Execução #${data.syncRunId}: ${syncRunStatusLabel(data.status)} — ${data.changedProducts} alterados, ${data.appliedProducts} aplicados, ${data.failedProducts} falhas.`,
        )
        router.refresh()
      }
    } catch (err) {
      setResult(`Erro: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="section section--pad">
      <h2 className="mb-3 text-sm font-bold text-[var(--texto)]">Disparar sincronização manual</h2>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as SyncKind)}
          className="rounded-[var(--radius-sm)] border border-[var(--borda)] bg-[var(--superficie)] px-2 py-1.5 text-[var(--texto)]"
        >
          <option value="both">Preço + Estoque</option>
          <option value="price">Só Preço</option>
          <option value="stock">Só Estoque</option>
        </select>

        <label className="flex items-center gap-1.5 text-[var(--texto)]">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          Apenas simular (não escreve no Wake)
        </label>

        {!dryRun && blockedReal && (
          <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
            Configuração incompleta -- execução real será recusada pelo motor.
          </span>
        )}

        <button
          onClick={trigger}
          disabled={busy}
          className={clsx(
            'ml-auto rounded-full px-4 py-1.5 text-sm font-bold text-white shadow-sm transition-colors disabled:opacity-50',
            'bg-[var(--marca)] hover:bg-[var(--marca-escura)]',
          )}
        >
          {busy ? 'Executando…' : 'Executar'}
        </button>
      </div>
      {result && <p className="mt-3 border-t border-[var(--borda)] pt-3 text-sm text-[var(--texto)]">{result}</p>}
    </div>
  )
}
