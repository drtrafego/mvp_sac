'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, MessageSquare, Users, BarChart3, Menu } from 'lucide-react'
import { Sheet } from '@/components/ui/sheet'
import { SidebarNavContent, SidebarFooter, type ActiveConnections, type SidebarMenuConfig } from './sidebar'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { cn } from '@/lib/utils'

const tabs = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Inbox', href: '/inbox', icon: MessageSquare },
  { label: 'Leads', href: '/leads', icon: Users },
  { label: 'Analytics', href: '/analytics-vendas', icon: BarChart3 },
]

interface MobileTabBarProps {
  isAdmin?: boolean
  activeConnections?: ActiveConnections
  sidebarConfig?: SidebarMenuConfig | null
}

export function MobileTabBar(props: MobileTabBarProps) {
  const pathname = usePathname()
  // O estado pertence à rota: navegar desmonta o menu e libera seu foco/scroll.
  return <MobileTabBarForRoute key={pathname} {...props} pathname={pathname} />
}

function MobileTabBarForRoute({ isAdmin, activeConnections, sidebarConfig, pathname }: MobileTabBarProps & { pathname: string }) {
  const [open, setOpen] = useState(false)

  // Dentro de uma conversa o rodapé é o campo de digitação, então a tab bar some
  const inConversation =
    (pathname.startsWith('/inbox/') && pathname !== '/inbox') ||
    (pathname.startsWith('/instagram/') && pathname !== '/instagram')
  if (inConversation) return null

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)
  const moreActive = !tabs.some(tab => isActive(tab.href))

  return (
    <>
      <nav className="fixed bottom-0 inset-x-0 z-40 lg:hidden border-t border-line-subtle bg-surface-panel pb-[env(safe-area-inset-bottom)]">
        <div className="flex h-16 items-stretch">
          {tabs.map(({ label, href, icon: Icon }) => {
            const active = isActive(href)
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'focus-ring flex flex-1 flex-col items-center justify-center gap-1 text-[11px] leading-none transition-colors',
                  active ? 'text-brand-ink font-bold' : 'text-fg-subtle hover:text-fg'
                )}
              >
                <Icon size={19} className="shrink-0" />
                <span className="truncate px-1">{label}</span>
              </Link>
            )
          })}

          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Abrir menu"
            aria-expanded={open}
            className={cn(
              'focus-ring flex flex-1 flex-col items-center justify-center gap-1 text-[11px] leading-none transition-colors cursor-pointer',
              open || moreActive ? 'text-brand-ink font-bold' : 'text-fg-subtle hover:text-fg'
            )}
          >
            <Menu size={19} className="shrink-0" />
            <span>Mais</span>
          </button>
        </div>
      </nav>

      <Sheet open={open} onOpenChange={setOpen} side="right" title="Menu">
        <SidebarNavContent
          isAdmin={isAdmin}
          activeConnections={activeConnections}
          sidebarConfig={sidebarConfig}
        />
        <ErrorBoundary fallback={null}>
          <SidebarFooter isAdmin={isAdmin} />
        </ErrorBoundary>
      </Sheet>
    </>
  )
}
