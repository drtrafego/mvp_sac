import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { StackProvider, StackTheme } from '@stackframe/stack'
import { stackServerApp } from '@/stack'
import { Providers } from '@/components/providers'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'SAC',
  description: 'Sistema de Atendimento ao Cliente e Recuperação de Vendas',
}

/*
  Tema das telas do Stack Auth (login, cadastro, recuperação de senha). Sem isto
  elas vinham com a paleta padrão da biblioteca, que não conversa com o produto.
  A biblioteca converte as cores com a lib `color`, então hex é aceito.
*/
const stackTheme = {
  dark: {
    background: '#0a0a0a',
    foreground: '#fafafa',
    card: '#101010',
    cardForeground: '#fafafa',
    popover: '#101010',
    popoverForeground: '#fafafa',
    primary: '#22c55e',
    primaryForeground: '#05140b',
    secondary: '#1a1a1a',
    secondaryForeground: '#fafafa',
    muted: '#171717',
    mutedForeground: '#a1a1a1',
    accent: '#1f1f1f',
    accentForeground: '#fafafa',
    border: '#242424',
    input: '#242424',
    ring: '#22c55e',
  },
  light: {
    primary: '#16a34a',
    primaryForeground: '#ffffff',
    ring: '#16a34a',
  },
  radius: '0.75rem',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const stackProjectId = process.env.NEXT_PUBLIC_STACK_PROJECT_ID || process.env.STACK_PROJECT_ID

  return (
    <html lang="pt-BR" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full`}>
      <body className="h-full bg-surface-base text-fg antialiased">
        <Providers>
          {stackProjectId ? (
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            <StackProvider app={stackServerApp as any} lang="pt-BR">
              <StackTheme theme={stackTheme}>{children}</StackTheme>
            </StackProvider>
          ) : children}
        </Providers>
      </body>
    </html>
  )
}
