import type { Metadata } from 'next'
import { Montserrat } from 'next/font/google'
import './globals.css'

// Casca minima -- so fonte de marca + reset global. O Casa Hub e standalone
// desde 03/09/2026 (saiu do ecossistema do Portal Interno, que so roda em
// horario comercial): sem as tags /_portal/shared/navbar.css|js daqui, sem
// o Topbar aqui (ele mora no layout do grupo (app), porque as telas de
// login/cadastro em (auth) nao devem exibir a navegacao interna).
const montserrat = Montserrat({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--fonte-marca',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Casa Hub — Central de Integrações',
  description: 'Sincronização de preço e estoque do ERP (CISS/PODER) para o Wake Commerce -- fixadores/parafusos.',
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={montserrat.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
