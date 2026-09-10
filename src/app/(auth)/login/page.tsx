import { redirect } from 'next/navigation'
import { getSessionIdentity } from '@/lib/auth'
import { LoginForm } from './login-form'

export const dynamic = 'force-dynamic'

export default async function LoginPage() {
  // ja logado? nao faz sentido mostrar o formulario de novo.
  const identity = await getSessionIdentity()
  if (identity) redirect('/')

  return (
    <div className="section section--pad">
      <h1 className="mb-4 text-lg font-semibold text-[var(--texto)]">Entrar</h1>
      <LoginForm />
      {/* Sem "Cadastre-se" aberto de proposito (04/09/2026): um leigo entrando
          sozinho no Hub pode derrubar sync de preco/estoque de todo o
          e-commerce. Usuario novo so e criado por quem ja esta logado, em
          /usuarios. */}
      <p className="mt-4 text-center text-xs text-[var(--texto-suave)]">
        Acesso apenas por convite -- fale com um administrador do Casa Hub.
      </p>
    </div>
  )
}
