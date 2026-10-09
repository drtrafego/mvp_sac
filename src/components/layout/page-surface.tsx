'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

/** Keep conversation panes edge-to-edge; content pages share one inset. */
export function PageSurface({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const conversation = pathname === '/inbox' || pathname.startsWith('/inbox/')
    || pathname === '/instagram' || pathname.startsWith('/instagram/')
  const mode = conversation ? 'conversation' : pathname === '/pipeline' ? 'board' : 'content'

  return <div className="workspace-page" data-page-mode={mode}>{children}</div>
}
