'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDateTime } from '@/lib/format'

interface UserRow {
  id: number
  username: string
  displayName: string
  active: boolean
  createdAt: string
  lastLoginAt: string | null
}

// A tabela users guarda createdAt via CURRENT_TIMESTAMP do SQLite, que sai
// como "2026-09-04 09:24:11" -- sem 'T' e sem 'Z', mas o valor E UTC. Sem
// essa normalizacao o JS interpretaria como horario local e a data sairia
// 3h adiantada. A formatacao em si (fuso America/Sao_Paulo) vem do
// helper compartilhado -- ver src/lib/format.ts.
function fmtDate(iso: string | null): string {
  if (!iso) return 'nunca'
  const normalized = iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z')
  return formatDateTime(normalized)
}

export function UsersManager({ initialUsers, currentUserId }: { initialUsers: UserRow[]; currentUserId: number }) {
  const router = useRouter()
  const [users, setUsers] = useState(initialUsers)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [togglingId, setTogglingId] = useState<number | null>(null)

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < 8) {
      setError('A senha precisa ter pelo menos 8 caracteres.')
      return
    }
    if (password !== confirm) {
      setError('As senhas não conferem.')
      return
    }

    setLoading(true)
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName, password }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setError(data?.error ?? 'Falha ao criar usuário.')
        return
      }
      setUsername('')
      setDisplayName('')
      setPassword('')
      setConfirm('')
      router.refresh()
      if (typeof data?.userId === 'number') {
        setUsers((prev) => [...prev, { id: data.userId, username: username.trim(), displayName, active: true, createdAt: new Date().toISOString(), lastLoginAt: null }])
      }
    } finally {
      setLoading(false)
    }
  }

  async function toggleActive(user: UserRow) {
    setTogglingId(user.id)
    try {
      const res = await fetch('/api/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: user.id, active: !user.active }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setError(data?.error ?? 'Falha ao atualizar usuário.')
        return
      }
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, active: !u.active } : u)))
      router.refresh()
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="section section--pad">
        <h2 className="mb-3 text-sm font-medium text-[var(--texto)]">Criar novo usuário</h2>
        <form onSubmit={handleCreate} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold text-[var(--texto-suave)]">Nome de exibição</label>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                required
                className="w-full rounded-[var(--radius-sm)] border border-[var(--borda)] bg-[var(--superficie)] px-3 py-2 text-sm text-[var(--texto)]"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-[var(--texto-suave)]">Usuário</label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                required
                className="w-full rounded-[var(--radius-sm)] border border-[var(--borda)] bg-[var(--superficie)] px-3 py-2 text-sm text-[var(--texto)]"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-[var(--texto-suave)]">Senha</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
                className="w-full rounded-[var(--radius-sm)] border border-[var(--borda)] bg-[var(--superficie)] px-3 py-2 text-sm text-[var(--texto)]"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-[var(--texto-suave)]">Confirmar senha</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
                minLength={8}
                className="w-full rounded-[var(--radius-sm)] border border-[var(--borda)] bg-[var(--superficie)] px-3 py-2 text-sm text-[var(--texto)]"
              />
            </div>
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="rounded-full bg-[var(--marca)] px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[var(--marca-escura)] disabled:opacity-50"
          >
            {loading ? 'Criando…' : 'Criar usuário'}
          </button>
        </form>
      </div>

      <div className="section section--pad">
        <h2 className="mb-3 text-sm font-medium text-[var(--texto)]">Usuários cadastrados</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-[var(--texto-suave)]">
                <th className="pb-2 pr-3 font-medium">Nome</th>
                <th className="pb-2 pr-3 font-medium">Usuário</th>
                <th className="pb-2 pr-3 font-medium">Status</th>
                <th className="pb-2 pr-3 font-medium">Último login</th>
                <th className="pb-2 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-[var(--borda)]">
                  <td className="py-2 pr-3 text-[var(--texto)]">
                    {u.displayName}
                    {u.id === currentUserId && <span className="ml-1.5 text-xs text-[var(--texto-suave)]">(você)</span>}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs text-[var(--texto-suave)]">{u.username}</td>
                  <td className="py-2 pr-3">
                    <span
                      className={
                        u.active
                          ? 'rounded-full bg-emerald-50 px-2 py-0.5 text-2xs font-semibold text-emerald-700'
                          : 'rounded-full bg-red-50 px-2 py-0.5 text-2xs font-semibold text-red-700'
                      }
                    >
                      {u.active ? 'ativo' : 'inativo'}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-xs text-[var(--texto-suave)]">{fmtDate(u.lastLoginAt)}</td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => toggleActive(u)}
                      disabled={togglingId === u.id || u.id === currentUserId}
                      className="rounded-full border border-[var(--borda)] px-3 py-1 text-xs font-semibold text-[var(--texto)] transition-colors hover:bg-[var(--marca-lavada)] disabled:opacity-40"
                    >
                      {u.active ? 'Desativar' : 'Reativar'}
                    </button>
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
