import { db, schema } from '@/lib/db'
import { getSessionIdentity } from '@/lib/auth'
import { UsersManager } from '@/components/users-manager'

export const dynamic = 'force-dynamic'

// Gestao de usuarios -- so existe aqui dentro (autenticado). Nao ha mais
// cadastro publico: um usuario so nasce quando alguem ja logado o cria
// (04/09/2026, ver src/app/api/users/route.ts pro porque).
export default async function UsuariosPage() {
  const identity = await getSessionIdentity()
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--texto)]">Usuários</h1>
        <p className="text-sm text-[var(--texto-suave)]">
          Acesso geral: todo usuário criado aqui já tem acesso completo ao Casa Hub. Não há cadastro público -- só quem
          já está logado pode criar um usuário novo.
        </p>
      </div>
      <UsersManager initialUsers={users} currentUserId={identity?.userId ?? 0} />
    </div>
  )
}
