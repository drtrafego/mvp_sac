'use client'

import Link from 'next/link'

export default function InboxError({ reset }: { reset: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-1 items-center justify-center bg-surface-base p-6">
      <div role="alert" className="max-w-md rounded-2xl border border-rose-500/25 bg-rose-500/10 p-6 text-center">
        <h2 className="text-h3 font-bold text-fg">Não foi possível abrir Conversas</h2>
        <p className="mt-2 text-body text-fg-muted">
          A sessão, o banco de dados ou a resposta do Inbox não terminou de carregar.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-lg bg-brand-solid px-3 py-2 text-micro font-bold text-on-accent"
          >
            Tentar novamente
          </button>
          <Link
            href="/handler/sign-in?after_auth_return_to=%2Finbox"
            className="rounded-lg border border-line-subtle px-3 py-2 text-micro font-bold text-fg-muted"
          >
            Entrar novamente
          </Link>
        </div>
      </div>
    </div>
  )
}
