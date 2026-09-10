import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { runSync } from '@/lib/sync/engine'
import { LockUnavailableError } from '@/lib/sync/lock'
import { requireSessionIdentity } from '@/lib/auth'

// Disparo manual do motor de sincronizacao -- usado pelo painel web
// (src/components/sync-trigger-panel.tsx). O worker agendado (worker/
// index.ts) chama runSync() diretamente, sem passar por HTTP, mas o
// resultado e identico: mesmo core, mesmas tabelas, mesma trilha de
// auditoria.

const bodySchema = z.object({
  kind: z.enum(['price', 'stock', 'both']),
  dryRun: z.boolean(),
})

export async function POST(req: NextRequest) {
  const identity = await requireSessionIdentity()
  if ('error' in identity) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Corpo inválido -- esperado {kind, dryRun}' }, { status: 400 })
  }

  try {
    const result = await runSync({
      kind: parsed.data.kind,
      dryRun: parsed.data.dryRun,
      trigger: 'manual',
      triggeredBy: identity.username,
    })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof LockUnavailableError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
