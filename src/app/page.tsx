import { redirect } from 'next/navigation'
import { getSessionIdentity } from '@/lib/auth'
import { Topbar } from '@/components/topbar'
import { VisaoGeralDashboard } from '@/components/visao-geral-dashboard'

export const dynamic = 'force-dynamic'

// Raiz literal "/" fora do grupo (app) -- ver comentario em
// src/components/visao-geral-dashboard.tsx pro motivo (bug do Next.js na
// raiz de um route group). Este arquivo duplica o guard+Topbar de
// src/app/(app)/layout.tsx pra essa unica rota; as demais paginas
// autenticadas continuam vivendo em (app)/ normalmente.
export default async function HomePage() {
  const identity = await getSessionIdentity()
  if (!identity) redirect('/login')
  return (
    <>
      <Topbar displayName={identity.displayName} />
      <main className="shell py-6">
        <VisaoGeralDashboard />
      </main>
    </>
  )
}
