import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db, schema } from '@/lib/db'
import { requireSessionIdentity, registerUser } from '@/lib/auth'

// Gestao de usuarios -- so pra quem ja esta logado (04/09/2026: fechamos o
// cadastro publico porque um leigo entrando sozinho no Hub pode derrubar
// sync de preco/estoque de todo o e-commerce). Continua "acesso geral": todo
// usuario criado aqui ja nasce ativo e com acesso completo, sem tabela de
// permissao por recurso -- so a CRIACAO que agora exige sessao valida.
//
// POST nao chama establishSession() pro usuario novo -- diferente do antigo
// /api/auth/register, aqui quem cria continua logado como si mesmo.

export async function GET() {
  const identity = await requireSessionIdentity()
  if ('error' in identity) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const users = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      active: schema.users.active,
      createdAt: schema.users.createdAt,
      lastLoginAt: schema.users.lastLoginAt,
    })
    .from(schema.users)
    .orderBy(schema.users.createdAt)

  return NextResponse.json({ users })
}

const bodySchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, 'Usuário precisa ter pelo menos 3 caracteres.')
    .regex(/^[a-zA-Z0-9._-]+$/, 'Usuário só pode ter letras, números, ponto, hífen e underscore.'),
  displayName: z.string().trim().min(1, 'Nome de exibição é obrigatório.'),
  password: z.string().min(8, 'Senha precisa ter pelo menos 8 caracteres.'),
})

export async function POST(req: NextRequest) {
  const identity = await requireSessionIdentity()
  if ('error' in identity) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 })
  }

  try {
    const result = await registerUser(parsed.data.username, parsed.data.displayName, parsed.data.password)
    return NextResponse.json({ ok: true, userId: result.userId })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 })
  }
}

const patchSchema = z.object({
  id: z.number().int().positive(),
  active: z.boolean(),
})

// Desativar/reativar usuario (nunca deleta linha -- preserva historico de
// quem alterou o que). Mesmo padrao "acesso geral": nao existe usuario
// "mais admin que outro", so ativo/inativo.
export async function PATCH(req: NextRequest) {
  const identity = await requireSessionIdentity()
  if ('error' in identity) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const parsed = patchSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 })
  }
  if (parsed.data.id === identity.userId && !parsed.data.active) {
    return NextResponse.json({ error: 'Você não pode desativar o seu próprio usuário.' }, { status: 400 })
  }

  await db.update(schema.users).set({ active: parsed.data.active }).where(eq(schema.users.id, parsed.data.id))
  return NextResponse.json({ ok: true })
}
