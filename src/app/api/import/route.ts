import { NextRequest, NextResponse } from 'next/server'
import { importWhitelistCsv } from '@/lib/csv/import'
import { requireSessionIdentity } from '@/lib/auth'

// Upload do CSV de whitelist (ciss_product_id, wake_sku, active). Aceita
// multipart/form-data com campo "file". O wake_product_variant_id e
// resolvido sozinho por linha via API do Wake (ver src/lib/csv/import.ts).

export async function POST(req: NextRequest) {
  const identity = await requireSessionIdentity()
  if ('error' in identity) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'Envie o CSV no campo "file" (multipart/form-data)' }, { status: 400 })
  }

  const content = await file.text()

  try {
    const result = await importWhitelistCsv(content, file.name, identity.username)
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
