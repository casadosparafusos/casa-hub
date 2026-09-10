'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function LoginForm() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setError(data?.error ?? 'Falha ao entrar.')
        return
      }
      router.push('/')
      router.refresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-semibold text-[var(--texto-suave)]">Usuário</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
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
          autoComplete="current-password"
          required
          className="w-full rounded-[var(--radius-sm)] border border-[var(--borda)] bg-[var(--superficie)] px-3 py-2 text-sm text-[var(--texto)]"
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-full bg-[var(--marca)] px-4 py-2 text-sm font-bold text-white shadow-sm transition-colors hover:bg-[var(--marca-escura)] disabled:opacity-50"
      >
        {loading ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  )
}
