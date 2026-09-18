import { NextRequest, NextResponse } from 'next/server'
import { requireSessionIdentity } from '@/lib/auth'
import { deactivateConfig, reactivateConfig } from '@/lib/measured-packages/service'
import { MeasuredPackageError, MeasuredPackageInfraError } from '@/lib/measured-packages/types'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const identity = await requireSessionIdentity()
  if ('error' in identity) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const { id } = await params
  const configId = Number(id)
  if (!Number.isInteger(configId)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const body = await req.json().catch(() => null)
  const action = body?.action

  try {
    if (action === 'deactivate') {
      await deactivateConfig(configId, identity.username)
      return NextResponse.json({ ok: true })
    }
    if (action === 'reactivate') {
      const config = await reactivateConfig(configId, identity.username)
      return NextResponse.json({ config })
    }
    return NextResponse.json({ error: 'action deve ser "deactivate" ou "reactivate"' }, { status: 400 })
  } catch (err) {
    if (err instanceof MeasuredPackageInfraError) return NextResponse.json({ error: err.message }, { status: 502 })
    if (err instanceof MeasuredPackageError) return NextResponse.json({ error: err.message }, { status: 400 })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
