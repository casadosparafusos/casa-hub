import { redirect } from 'next/navigation'
import { getSessionIdentity } from '@/lib/auth'
import { Topbar } from '@/components/topbar'

// Guarda de autenticacao pra TODAS as telas internas do Casa Hub -- exceto
// /login, que mora no grupo (auth) e nao passa por aqui. Criacao de usuario
// agora e so em /usuarios (autenticado, aqui dentro) -- nao existe mais
// cadastro publico.
// Rodando como Server Component: sem sessao valida, redireciona antes de
// qualquer dado sensivel ser buscado ou renderizado.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const identity = await getSessionIdentity()
  if (!identity) redirect('/login')

  return (
    <>
      <Topbar displayName={identity.displayName} />
      <main className="shell py-6">{children}</main>
    </>
  )
}
