'use client'

import Link from 'next/link'
import { Building2, LogOut, Zap } from 'lucide-react'
import { useUser } from '@stackframe/stack'

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-md)]"
        style={{ background: 'var(--brand-glow)', border: '1px solid rgba(34,197,94,0.22)' }}
      >
        <Zap size={13} className="text-brand-ink" />
      </div>
      <div className="min-w-0">
        <span className="block text-h3 text-fg leading-tight">SAC</span>
        <span className="block text-micro text-st-atencao leading-tight">Painel Admin</span>
      </div>
    </div>
  )
}

function SignOutButton({ className }: { className?: string }) {
  const user = useUser()
  return (
    <button
      onClick={() => user?.signOut()}
      title="Sair"
      className={
        className ??
        'focus-ring flex w-full items-center gap-2.5 rounded-[var(--r-md)] px-3 py-3 text-[0.8125rem] text-fg-subtle transition-colors hover:bg-[var(--line-subtle)] hover:text-fg lg:py-[7px]'
      }
    >
      <LogOut size={16} className="shrink-0" />
      <span>Sair</span>
    </button>
  )
}

/** Barra superior do painel admin no celular, onde a lateral não cabe. */
export function AdminTopbar() {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line-subtle bg-surface-panel px-4 lg:hidden">
      <BrandMark />
      <SignOutButton className="focus-ring flex h-11 w-11 items-center justify-center rounded-[var(--r-md)] text-fg-subtle hover:bg-surface-inset hover:text-fg" />
    </header>
  )
}

export function AdminSidebar() {
  return (
    <aside className="hidden h-full w-[248px] shrink-0 flex-col border-r border-line-subtle bg-surface-panel lg:flex">
      <div className="flex h-14 items-center border-b border-line-subtle px-4">
        <BrandMark />
      </div>

      <nav className="flex-1 space-y-0.5 px-2.5 py-3">
        <Link
          href="/empresas"
          className="focus-ring relative flex items-center gap-2.5 rounded-[var(--r-md)] bg-[var(--line-subtle)] px-3 py-[7px] text-[0.8125rem] font-medium text-fg"
        >
          <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-brand-ink" />
          <Building2 size={16} className="shrink-0 text-brand-ink" />
          Empresas
        </Link>
      </nav>

      <div className="border-t border-line-subtle px-2.5 py-3">
        <SignOutButton />
      </div>
    </aside>
  )
}
