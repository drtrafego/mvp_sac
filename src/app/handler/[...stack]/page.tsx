import { StackHandler } from '@stackframe/stack'
import { Zap, KeyRound } from 'lucide-react'
import { stackServerApp } from '@/stack'

/*
  As telas do Stack Auth (login, cadastro, recuperação de senha) são a primeira
  imagem do produto. O handler continua cuidando do formulário, mas ganha a marca
  no topo e um fundo próprio, senão a entrada do sistema é uma página anônima.
  O idioma e as cores do formulário vêm do StackProvider no layout raiz.
*/
export default function Handler(props: unknown) {
  const stackProjectId = process.env.NEXT_PUBLIC_STACK_PROJECT_ID || process.env.STACK_PROJECT_ID

  if (!stackProjectId) {
    return (
      <div className="relative flex min-h-screen items-center justify-center bg-surface-base p-6">
        <div className="relative z-10 w-full max-w-md space-y-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel p-6 text-center shadow-xl">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-[var(--st-atencao-bg)] text-[var(--st-atencao)]">
            <KeyRound size={24} />
          </div>
          <h2 className="text-h3 font-semibold text-fg">Configuração do Stack Auth Pendente</h2>
          <p className="text-body text-fg-subtle">
            As variáveis de ambiente do <strong>Stack Auth</strong> precisam ser adicionadas na Vercel para ativar a tela de login.
          </p>
          <div className="rounded-[var(--r-md)] border border-line-subtle bg-surface-base p-3.5 text-left text-micro font-mono text-fg-muted space-y-1">
            <p>• NEXT_PUBLIC_STACK_PROJECT_ID (ou STACK_PROJECT_ID)</p>
            <p>• NEXT_PUBLIC_STACK_PUBLISHABLE_CLIENT_KEY (ou STACK_PUBLISHABLE_CLIENT_KEY)</p>
            <p>• STACK_SECRET_SERVER_KEY</p>
          </div>
          <p className="text-micro text-fg-faint">
            Após adicionar as variáveis em <em>Vercel &gt; Settings &gt; Environment Variables</em>, faça um <strong>Redeploy</strong>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative min-h-screen bg-surface-base">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(680px circle at 50% -10%, var(--brand-glow), transparent 65%)',
        }}
      />

      {/*
        A marca fica sobre o formulário, que o handler centraliza no viewport. Em
        tela baixa, como celular deitado, os dois se encontrariam, portanto ela some.
      */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-2 px-6 pt-12 text-center [@media(max-height:660px)]:hidden">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-[var(--r-md)]"
            style={{ background: 'var(--brand-glow)', border: '1px solid rgba(34,197,94,0.22)' }}
          >
            <Zap size={15} className="text-brand-ink" />
          </div>
          <span className="text-h2 text-fg">SAC</span>
        </div>
        <p className="text-micro text-fg-subtle">
          Sistema de Atendimento ao Cliente e Recuperação
        </p>
      </div>

      <StackHandler app={stackServerApp} {...(props as object)} fullPage />
    </div>
  )
}
