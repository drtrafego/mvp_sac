'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { RefreshCw } from 'lucide-react'

export function RefreshButton() {
  const router = useRouter()
  const [pending, start] = useTransition()
  return (
    <button
      onClick={() => start(() => router.refresh())}
      disabled={pending}
      className="focus-ring flex h-[var(--control-lg)] items-center gap-2 rounded-[var(--r-md)] border border-line-subtle bg-surface-inset px-3 text-body text-fg-muted transition-colors hover:text-fg disabled:opacity-50 lg:h-[var(--control-sm)]"
    >
      <RefreshCw size={14} className={pending ? 'animate-spin' : ''} />
      Atualizar
    </button>
  )
}
