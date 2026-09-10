'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import clsx from 'clsx'
import { SECRET_CONFIGURED_SENTINEL } from '@/lib/settings-shared'

interface FieldDef {
  key: string
  label: string
  help: string
  /** Campo write-only: valor nunca chega ao cliente, so um booleano "configurado". */
  secret?: boolean
}

export function SettingsForm({ fields, initialValues }: { fields: FieldDef[]; initialValues: Record<string, string | null> }) {
  const router = useRouter()
  const [values, setValues] = useState<Record<string, string>>(
    // Campo secreto nunca comeca preenchido -- o valor real nunca existiu no cliente.
    Object.fromEntries(fields.map((f) => [f.key, f.secret ? '' : initialValues[f.key] ?? ''])),
  )
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [message, setMessage] = useState<{ key: string; text: string; ok: boolean } | null>(null)

  async function save(key: string) {
    const value = values[key]?.trim()
    if (!value) return
    setSavingKey(key)
    setMessage(null)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      })
      const data = await res.json()
      if (!res.ok) {
        setMessage({ key, text: data.error ?? res.statusText, ok: false })
      } else {
        setMessage({ key, text: 'Salvo.', ok: true })
        setEditingKey(null)
        router.refresh()
      }
    } catch (err) {
      setMessage({ key, text: err instanceof Error ? err.message : String(err), ok: false })
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <div className="divide-y divide-[var(--borda)]">
      {fields.map((f) => {
        const confirmed = f.secret ? initialValues[f.key] === SECRET_CONFIGURED_SENTINEL : Boolean(initialValues[f.key])
        const isEditing = editingKey === f.key || !confirmed
        const rowMessage = message?.key === f.key ? message : null

        return (
          <div key={f.key} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="min-w-0 sm:w-[46%]">
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-[var(--radius-sm)] bg-[var(--superficie-sunken)] px-1.5 py-0.5 font-mono text-xs font-bold text-[var(--texto)]">
                  {f.key}
                </code>
                <span
                  className={clsx(
                    'rounded-full px-2 py-0.5 text-2xs font-semibold',
                    confirmed ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
                  )}
                >
                  {confirmed ? 'confirmado' : 'pendente'}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[var(--texto-suave)]">{f.help}</p>
            </div>

            <div className="sm:w-[54%]">
              {isEditing ? (
                <div className="flex gap-2">
                  <input
                    type={f.secret ? 'password' : 'text'}
                    autoComplete={f.secret ? 'new-password' : 'off'}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder={f.secret ? 'Colar novo valor (o atual não pode ser visualizado)' : f.label}
                    autoFocus={editingKey === f.key}
                    className="flex-1 rounded-[var(--radius-sm)] border border-[var(--borda)] bg-[var(--superficie)] px-2.5 py-1.5 text-sm text-[var(--texto)] focus:border-[var(--marca)] focus:outline-none"
                  />
                  <button
                    onClick={() => save(f.key)}
                    disabled={savingKey === f.key}
                    className="shrink-0 rounded-full bg-[var(--marca)] px-4 py-1.5 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[var(--marca-escura)] disabled:opacity-50"
                  >
                    {savingKey === f.key ? 'Salvando…' : 'Salvar'}
                  </button>
                  {confirmed && (
                    <button
                      onClick={() => {
                        setEditingKey(null)
                        setValues((prev) => ({ ...prev, [f.key]: f.secret ? '' : initialValues[f.key] ?? '' }))
                      }}
                      className="shrink-0 rounded-full border border-[var(--borda)] px-3 py-1.5 text-sm text-[var(--texto-suave)] transition-colors hover:bg-[var(--superficie-hover)]"
                    >
                      Cancelar
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--borda)] bg-[var(--superficie-sunken)] px-2.5 py-1.5">
                  {f.secret ? (
                    <span
                      className="select-none truncate font-mono text-sm tracking-widest text-[var(--texto-suave)]"
                      style={{ userSelect: 'none' }}
                      onCopy={(e) => e.preventDefault()}
                      onContextMenu={(e) => e.preventDefault()}
                      title="Valor oculto por segurança -- não pode ser visualizado nem copiado"
                    >
                      ••••••••••••••••
                    </span>
                  ) : (
                    <span className="truncate font-mono text-sm text-[var(--texto)]">{initialValues[f.key]}</span>
                  )}
                  <button
                    onClick={() => setEditingKey(f.key)}
                    className="shrink-0 text-xs font-semibold text-[var(--marca)] hover:underline"
                  >
                    {f.secret ? 'Substituir' : 'Editar'}
                  </button>
                </div>
              )}
              {rowMessage && (
                <p className={clsx('mt-1.5 text-xs', rowMessage.ok ? 'text-emerald-700' : 'text-red-600')}>{rowMessage.text}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
