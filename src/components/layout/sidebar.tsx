'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  Receipt,
  QrCode,
  ShoppingCart,
  CreditCard,
  CheckCircle,
  MessageSquare,
  Settings,
  LogOut,
  Users,
  BookOpen,
  Building2,
  BarChart3,
  Columns3,
  Zap,
  Webhook,
} from 'lucide-react'
import { useUser } from '@stackframe/stack'
import { ThemeToggle } from '@/components/theme-toggle'
import { cn } from '@/lib/utils'

export const mainNav = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Pipeline', href: '/pipeline', icon: Columns3 },
  { label: 'Inbox', href: '/inbox', icon: MessageSquare },
  { label: 'Leads', href: '/leads', icon: Users },
  { label: 'Analytics Vendas', href: '/analytics-vendas', icon: BarChart3 },
]

export const recoveryNav = [
  { label: 'Boleto', href: '/boleto', icon: Receipt },
  { label: 'Pix', href: '/pix', icon: QrCode },
  { label: 'Carrinho', href: '/carrinho', icon: ShoppingCart },
  { label: 'Cartão Recusado', href: '/cartao-recusado', icon: CreditCard },
  { label: 'Compra Aprovada', href: '/compra-aprovada', icon: CheckCircle },
]

export const bottomNav = [
  { label: 'Biblioteca', href: '/biblioteca', icon: BookOpen },
  { label: 'Webhooks Log', href: '/webhooks-log', icon: Webhook },
  { label: 'Configurações', href: '/configuracoes', icon: Settings },
]

interface SidebarProps {
  isAdmin?: boolean
}

export function NavItem({
  label,
  href,
  icon: Icon,
  isActive,
}: {
  label: string
  href: string
  icon: React.ElementType
  isActive: boolean
}) {
  return (
    <Link
      href={href}
      title={label}
      className={cn(
        // 44px de alvo de toque no celular, 34px no desktop para caber a lista inteira
        'nav-item focus-ring group relative flex items-center gap-2.5 px-3 py-3 lg:py-[7px] rounded-[var(--r-md)]',
        'text-[0.8125rem] transition-colors duration-150 ease-out cursor-pointer',
        isActive
          ? 'bg-[var(--line-subtle)] text-fg font-medium'
          : 'text-fg-subtle hover:text-fg hover:bg-[var(--line-subtle)] font-normal'
      )}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full bg-brand-ink" />
      )}
      <Icon
        size={16}
        className={cn(
          'shrink-0 transition-colors duration-150',
          isActive ? 'text-brand-ink' : 'text-fg-faint group-hover:text-fg-muted'
        )}
      />
      <span className="nav-label truncate leading-none">{label}</span>
    </Link>
  )
}

/**
 * Lista de navegação sem o wrapper <aside>, reaproveitada pela sidebar de
 * desktop e pelo Sheet "Mais" do mobile. Com hideMain os 4 itens principais
 * somem, pois já ficam na tab bar inferior.
 */
export function SidebarNavContent({
  hideMain = false,
  className,
}: {
  hideMain?: boolean
  className?: string
}) {
  const pathname = usePathname()

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)

  return (
    <nav className={cn('scroll-thin min-h-0 overflow-y-auto px-2.5 py-3 space-y-3.5', className)}>
      {!hideMain && (
        <div className="space-y-0.5">
          {mainNav.map(({ label, href, icon }) => (
            <NavItem key={href} label={label} href={href} icon={icon} isActive={isActive(href)} />
          ))}
        </div>
      )}

      <div className="space-y-0.5">
        <p className="nav-group-label px-3 mb-1.5 text-label uppercase text-fg-faint">
          <span>Recuperação</span>
        </p>
        {recoveryNav.map(({ label, href, icon }) => (
          <NavItem key={href} label={label} href={href} icon={icon} isActive={isActive(href)} />
        ))}
      </div>

      <div className="space-y-0.5">
        <p className="nav-group-label px-3 mb-1.5 text-label uppercase text-fg-faint">
          <span>Sistema</span>
        </p>
        {bottomNav.map(({ label, href, icon }) => (
          <NavItem key={href} label={label} href={href} icon={icon} isActive={isActive(href)} />
        ))}
      </div>
    </nav>
  )
}

/** Rodapé com Painel Admin, tema e sair. Usado na sidebar e no Sheet mobile. */
export function SidebarFooter({ isAdmin }: SidebarProps) {
  const user = useUser()

  return (
    <div className="px-2.5 py-3 border-t border-line-subtle space-y-0.5 shrink-0">
      {isAdmin && (
        <Link
          href="/empresas"
          title="Painel Admin"
          className="nav-item focus-ring flex items-center gap-2.5 px-3 py-3 lg:py-[7px] rounded-[var(--r-md)] text-[0.8125rem] font-medium text-[var(--st-atencao)] hover:bg-[var(--line-subtle)] transition-colors duration-150 ease-out w-full cursor-pointer"
        >
          <Building2 size={16} className="shrink-0" />
          <span className="nav-label">Painel Admin</span>
        </Link>
      )}
      <ThemeToggle />
      <button
        onClick={() => user?.signOut()}
        title="Sair"
        className="nav-item focus-ring flex items-center gap-2.5 px-3 py-3 lg:py-[7px] rounded-[var(--r-md)] text-fg-subtle hover:text-fg hover:bg-[var(--line-subtle)] transition-colors duration-150 ease-out w-full text-[0.8125rem] cursor-pointer"
      >
        <LogOut size={16} className="shrink-0" />
        <span className="nav-label">Sair</span>
      </button>
    </div>
  )
}

export function SidebarBrand() {
  return (
    <div className="nav-brand flex items-center gap-2.5">
      <div
        className="w-7 h-7 rounded-[var(--r-md)] flex items-center justify-center shrink-0"
        style={{ background: 'var(--brand-glow)', border: '1px solid rgba(34,197,94,0.22)' }}
      >
        <Zap size={13} className="text-brand-ink" />
      </div>
      <span className="nav-brand-text text-fg text-h3 font-semibold tracking-tight">SAC</span>
    </div>
  )
}

export function Sidebar({ isAdmin }: SidebarProps) {
  return (
    <aside
      className={cn(
        'sidebar-rail hidden lg:grid h-full shrink-0 border-r border-line-subtle bg-surface-panel',
        // Trilho de ícones em 1024, completa a partir de 1280, mais larga em 1536
        'w-16 xl:w-[248px] 2xl:w-[272px]',
        // Marca, navegação e rodapé: só a linha do meio rola, então nada é cortado
        'grid-rows-[auto_1fr_auto]'
      )}
    >
      <div className="nav-brand px-4 h-14 flex items-center border-b border-line-subtle">
        <SidebarBrand />
      </div>

      <SidebarNavContent />

      <SidebarFooter isAdmin={isAdmin} />
    </aside>
  )
}
