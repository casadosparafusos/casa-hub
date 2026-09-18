import { NextRequest, NextResponse } from 'next/server'
import { requireSessionIdentity } from '@/lib/auth'
import { listConfigs, listPendingProducts, upsertBySku } from '@/lib/measured-packages/service'
import { MeasuredPackageError, MeasuredPackageInfraError } from '@/lib/measured-packages/types'

export async function GET() {
  const identity = await requireSessionIdentity()
  if ('error' in identity) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const [configs, pending] = await Promise.all([listConfigs(), listPendingProducts()])
  return NextResponse.json({ configs, pending })
}

export async function POST(req: NextRequest) {
  const identity = await requireSessionIdentity()
  if ('error' in identity) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const body = await req.json().catch(() => null)
  const sku = typeof body?.sku === 'string' ? body.sku : ''
  const quantity = typeof body?.quantity === 'number' ? body.quantity : Number(body?.quantity)

  try {
    const config = await upsertBySku({ sku, quantity, actor: identity.username })
    return NextResponse.json({ config })
  } catch (err) {
    if (err instanceof MeasuredPackageInfraError) return NextResponse.json({ error: err.message }, { status: 502 })
    if (err instanceof MeasuredPackageError) return NextResponse.json({ error: err.message }, { status: 400 })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
