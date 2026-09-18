import { NextRequest, NextResponse } from 'next/server'
import { requireSessionIdentity } from '@/lib/auth'
import { parseImportFile, MAX_FILE_BYTES } from '@/lib/measured-packages/parser'
import { validateImportRows, applyImport } from '@/lib/measured-packages/import'
import { MeasuredPackageError, MeasuredPackageInfraError } from '@/lib/measured-packages/types'

export async function POST(req: NextRequest) {
  const identity = await requireSessionIdentity()
  if ('error' in identity) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const mode = req.nextUrl.searchParams.get('mode')
  if (mode !== 'preview' && mode !== 'apply') {
    return NextResponse.json({ error: 'Informe ?mode=preview ou ?mode=apply' }, { status: 400 })
  }

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'Envie o arquivo no campo "file" (multipart/form-data)' }, { status: 400 })
  }
  // Tech Lead review PR #5, achado #7: checar o tamanho declarado ANTES de
  // bufferizar -- ler o arquivo inteiro na memoria so pra descobrir que
  // excede o limite desperdiça memoria/CPU a toa (upload grande de proposito).
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'Arquivo excede o limite de 5MB.' }, { status: 413 })
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const rows = await parseImportFile(buffer, file.name)

    if (mode === 'preview') {
      const result = await validateImportRows(rows)
      return NextResponse.json(result)
    }

    const result = await applyImport(rows, { actor: identity.username, filename: file.name })
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof MeasuredPackageInfraError) return NextResponse.json({ error: err.message }, { status: 502 })
    if (err instanceof MeasuredPackageError) return NextResponse.json({ error: err.message }, { status: 400 })
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
