'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

/** Keep conversation panes edge-to-edge; content pages share one inset. */
export function PageSurface({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const conversation = pathname === '/inbox' || pathname.startsWith('/inbox/')
    || pathname === '/instagram' || pathname.startsWith('/instagram/')
  const activeConversation =
    (pathname.startsWith('/inbox/') && pathname !== '/inbox') ||
    (pathname.startsWith('/instagram/') && pathname !== '/instagram')
  const mode = conversation ? 'conversation' : pathname === '/pipeline' ? 'board' : 'content'

  return (
    <>
      <div className="workspace-page" data-page-mode={mode} data-conversation-open={activeConversation || undefined}>
        {children}
      </div>
      {!activeConversation && (
        <div
          aria-hidden
          className="shrink-0 h-[calc(4rem+1px+env(safe-area-inset-bottom)+24px)] lg:hidden"
        />
      )}
    </>
  )
}
