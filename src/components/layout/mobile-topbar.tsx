'use client'

import { SidebarBrand } from './sidebar'
import { usePathname } from 'next/navigation'

/** Barra superior do mobile e tablet. O menu completo mora na tab bar inferior. */
export function MobileTopbar() {
  const pathname = usePathname()
  const inConversation =
    (pathname.startsWith('/inbox/') && pathname !== '/inbox') ||
    (pathname.startsWith('/instagram/') && pathname !== '/instagram')

  return (
    <header className={`h-14 items-center px-4 border-b border-line-subtle bg-surface-panel lg:hidden shrink-0 ${inConversation ? 'hidden md:flex' : 'flex'}`}>
      <SidebarBrand />
    </header>
  )
}
