import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { establishSession, verifyLogin } from '@/lib/auth'

const bodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Usuário e senha são obrigatórios.' }, { status: 400 })
  }

  const result = await verifyLogin(parsed.data.username, parsed.data.password)
  if (!result) {
    // mensagem generica de proposito -- nao revela se o usuario existe
    return NextResponse.json({ error: 'Usuário ou senha inválidos.' }, { status: 401 })
  }

  await establishSession(result.userId)
  return NextResponse.json({ ok: true })
}
