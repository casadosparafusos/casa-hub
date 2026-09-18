import { NextResponse } from 'next/server'
import { requireSessionIdentity } from '@/lib/auth'
import { generateTemplate } from '@/lib/measured-packages/template'

export async function GET() {
  const identity = await requireSessionIdentity()
  if ('error' in identity) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const buffer = await generateTemplate()
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="modelo-embalagens-kg-mt.xlsx"',
    },
  })
}
