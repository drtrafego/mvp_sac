'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, MessageSquare, Users, BarChart3, Menu } from 'lucide-react'
import { Sheet } from '@/components/ui/sheet'
import { SidebarNavContent, SidebarFooter } from './sidebar'
import { cn } from '@/lib/utils'

const tabs = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Inbox', href: '/inbox', icon: MessageSquare },
  { label: 'Leads', href: '/leads', icon: Users },
  { label: 'Analytics', href: '/analytics-vendas', icon: BarChart3 },
]

interface MobileTabBarProps {
  isAdmin?: boolean
}

export function MobileTabBar({ isAdmin }: MobileTabBarProps) {
  const pathname = usePathname()
  const [open, setOpen] = useState(false)

  // Fecha o menu sempre que a rota muda
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  // Dentro de uma conversa o rodapé é o campo de digitação, então a tab bar some
  const inConversation = pathname.startsWith('/inbox/') && pathname !== '/inbox'
  if (inConversation) return null

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)

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
                className={cn(
                  'flex flex-1 flex-col items-center justify-center gap-1 text-[11px] leading-none transition-colors',
                  active ? 'text-brand-ink' : 'text-fg-subtle hover:text-fg'
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
            className={cn(
              'flex flex-1 flex-col items-center justify-center gap-1 text-[11px] leading-none transition-colors cursor-pointer',
              open ? 'text-brand-ink' : 'text-fg-subtle hover:text-fg'
            )}
          >
            <Menu size={19} className="shrink-0" />
            <span>Mais</span>
          </button>
        </div>
      </nav>

      <Sheet open={open} onOpenChange={setOpen} side="right" title="Menu">
        <SidebarNavContent hideMain isAdmin={isAdmin} />
        <SidebarFooter isAdmin={isAdmin} />
      </Sheet>
    </>
  )
}
