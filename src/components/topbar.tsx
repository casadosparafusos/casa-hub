'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter, usePathname } from 'next/navigation'
import clsx from 'clsx'

// Header padrão Casa dos Parafusos (CDP Header v1) -- mesma estrutura de duas
// linhas do Portal/RD Gerencial/Reposição/Auditoria: barra azul com régua ciano
// de 3px, logo + nome do app + pílula de contexto + menu de conta na linha 1,
// pílulas de navegação na linha 2. Ver Portal/PADRAO_HEADER.md pras medidas de
// referência -- não inventar espaçamento novo aqui.
//
// Sub-navegacao pedida na especificacao (secao ~45): Visao Geral / Sinc.
// Precos / Sinc. Estoque / Produtos / Caixas / Historico / Configuracoes.
// "Caixas" fica visivel mas com badge "em breve" -- feature DISABLED no
// banco (ver schema.boxes) ate as regras de negocio serem confirmadas.
const NAV_ITEMS = [
  { href: '/', label: 'Visão Geral', disabled: false },
  { href: '/precos', label: 'Sinc. Preços', disabled: false },
  { href: '/estoque', label: 'Sinc. Estoque', disabled: false },
  { href: '/produtos', label: 'Produtos', disabled: false },
  { href: '/caixas', label: 'Caixas', disabled: true },
  { href: '/historico', label: 'Histórico', disabled: false },
  { href: '/usuarios', label: 'Usuários', disabled: false },
  { href: '/configuracoes', label: 'Configurações', disabled: false },
] as const

export function Topbar({ displayName }: { displayName: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    setLoggingOut(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } finally {
      router.push('/login')
      router.refresh()
    }
  }

  return (
    <header className="sticky top-0 z-20 border-b-[3px] border-[var(--marca-acento)] bg-[var(--marca)] text-white">
      <div className="shell flex items-center gap-[18px] pt-4">
        <span className="flex shrink-0 items-center">
          {/* Símbolo sozinho no estreito, assinatura completa a partir de 480px -- a
              assinatura deitada não sobrevive a telas estreitas, o símbolo sim. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/marca/logo-symbol.png" alt="Casa dos Parafusos" className="block h-[30px] w-auto min-[480px]:hidden" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/marca/logo-wordmark.png" alt="Casa dos Parafusos" className="hidden h-7 w-auto min-[480px]:block" />
        </span>

        <span aria-hidden="true" className="hidden h-[26px] w-px shrink-0 bg-white/20 min-[680px]:block" />

        {/* Nome do app + subtítulo do pedido de rebranding, na mesma linha (a
            régua vertical acima já separa da marca; aqui um interpunto separa
            nome de subtítulo -- ambos somem juntos no estreito, como o resto
            do contexto textual da linha 1). */}
        <span className="hidden items-baseline gap-2 whitespace-nowrap min-[680px]:flex">
          <span className="text-sm font-bold">Casa Hub</span>
          <span className="text-xs text-white/60">· Central de Integrações</span>
        </span>

        <span className="flex-1" />

        {/* Identifica de qual loja é o dado sincronizado com o Wake; some no
            estreito, onde empurraria a marca -- mesmo comportamento dos outros
            apps do ecossistema. */}
        <span className="hidden items-center gap-2 whitespace-nowrap rounded-[20px] bg-white/10 px-3.5 py-1.5 min-[860px]:flex">
          <span className="text-[11px] font-extrabold uppercase tracking-[0.08em] text-[var(--marca-acento)]">Loja 01</span>
          <span className="text-xs font-semibold tabular-nums text-white/80">02.532.281/0001-59</span>
        </span>

        {/* Acesso e geral (qualquer usuário cadastrado, sem permissão por
            recurso) -- então o menu de conta é só nome + sair, sem o menu
            compartilhado do Portal (o app não faz mais parte daquele
            ecossistema desde 03/09/2026). */}
        <div className="flex shrink-0 items-center gap-3">
          <span className="hidden text-xs font-semibold text-white/80 sm:inline">{displayName}</span>
          <button
            type="button"
            onClick={handleLogout}
            disabled={loggingOut}
            className="rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-white/80 transition-colors hover:bg-white/20 hover:text-white disabled:opacity-60"
          >
            Sair
          </button>
        </div>
      </div>

      <nav aria-label="Áreas do Casa Hub" className="shell flex gap-2 overflow-x-auto py-3">
        {NAV_ITEMS.map((item) => {
          const active = item.href === '/' ? pathname === '/' : pathname?.startsWith(item.href)

          if (item.disabled) {
            return (
              <span
                key={item.href}
                className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white/5 px-4 py-[9px] text-sm font-semibold text-white/50"
                title="Em breve -- regras de negócio ainda não confirmadas"
              >
                {item.label}
                <span className="rounded bg-white/15 px-1 text-2xs font-medium normal-case text-white/70">em breve</span>
              </span>
            )
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'shrink-0 whitespace-nowrap rounded-full px-4 py-[9px] text-sm transition-colors',
                active ? 'bg-white font-bold text-[var(--marca)]' : 'bg-white/10 font-semibold text-white/80 hover:bg-white/20 hover:text-white',
              )}
            >
              {item.label}
            </Link>
          )
        })}
      </nav>
    </header>
  )
}
