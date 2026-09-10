// Layout das telas publicas de autenticacao (login) -- sem Topbar, sem
// guarda de sessao (o proprio grupo (app) e que exige sessao). Se o
// usuario ja estiver logado e visitar /login, a pagina em si redireciona
// pra "/" (ver page.tsx).
//
// Logo: /marca/logo-wordmark.png é a versão branca+ciano, feita pra fundo
// ESCURO (é a que a Topbar usa, sobre o azul da marca) -- em cima do fundo
// claro daqui (--fundo) ela ficava com o "Casa dos" invisível. Fundo claro
// usa /marca/logo-wordmark-navy.png (azul+ciano), a variação certa pra essa
// combinação (04/09/2026, fonte: Logo Principal.png do branding oficial).
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--fundo)] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/marca/logo-wordmark-navy.png" alt="Casa dos Parafusos" className="h-8 w-auto" />
          <span className="text-sm font-semibold text-[var(--texto-suave)]">Casa Hub · Central de Integrações</span>
        </div>
        {children}
      </div>
    </div>
  )
}
