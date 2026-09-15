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
  Radio,
  Globe,
  Activity,
  FileCheck,
  Send,
  ListOrdered,
  ShieldCheck,
} from 'lucide-react'
import { useUser } from '@stackframe/stack'
import { ThemeToggle } from '@/components/theme-toggle'
import { cn } from '@/lib/utils'

export const mainNav = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Pipeline Kanban', href: '/pipeline', icon: Columns3 },
  { label: 'Inbox / Conversas', href: '/inbox', icon: MessageSquare },
  { label: 'Leads Recentes', href: '/leads', icon: Users },
]

export const analyticsNav = [
  { label: 'Analytics Vendas', href: '/analytics-vendas', icon: BarChart3 },
  { label: 'Canais de Atendimento', href: '/canais', icon: Radio },
  { label: 'Origens de Tráfego', href: '/origens', icon: Globe },
  { label: 'Operação & SLA', href: '/operacao', icon: Activity },
]

export const recoveryNav = [
  { label: 'Carrinho Abandonado', href: '/carrinho', icon: ShoppingCart },
  { label: 'Boleto Bancário', href: '/boleto', icon: Receipt },
  { label: 'Pix Pendente', href: '/pix', icon: QrCode },
  { label: 'Cartão Recusado', href: '/cartao-recusado', icon: CreditCard },
  { label: 'Compra Aprovada', href: '/compra-aprovada', icon: CheckCircle },
]

export const automationNav = [
  { label: 'Mensagens Aprovadas (HSM)', href: '/api-modelos', icon: FileCheck },
  { label: 'Campanhas Ativas', href: '/api-campanhas', icon: Send },
  { label: 'Follow-up Sequências', href: '/api-followup', icon: ListOrdered },
]

export const bottomNav = [
  { label: 'Webhooks Log', href: '/webhooks-log', icon: Webhook },
  { label: 'Biblioteca', href: '/biblioteca', icon: BookOpen },
  { label: 'Configurações & Contas', href: '/configuracoes', icon: Settings },
]

interface SidebarProps {
  isAdmin?: boolean
}

export function NavItem({
  label,
  href,
  icon: Icon,
  isActive,
  badge,
}: {
  label: string
  href: string
  icon: React.ElementType
  isActive: boolean
  badge?: string
}) {
  return (
    <Link
      href={href}
      title={label}
      className={cn(
        'nav-item focus-ring group relative flex items-center justify-between px-3 py-2.5 lg:py-[6.5px] rounded-[var(--r-md)]',
        'text-[0.8125rem] transition-colors duration-150 ease-out cursor-pointer',
        isActive
          ? 'bg-[var(--line-subtle)] text-fg font-medium'
          : 'text-fg-subtle hover:text-fg hover:bg-[var(--line-subtle)] font-normal'
      )}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        {isActive && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-full bg-brand-ink" />
        )}
        <Icon
          size={15}
          className={cn(
            'shrink-0 transition-colors duration-150',
            isActive ? 'text-brand-ink' : 'text-fg-faint group-hover:text-fg-muted'
          )}
        />
        <span className="nav-label truncate leading-none">{label}</span>
      </div>
      {badge && (
        <span className="text-[10px] uppercase font-bold text-brand-ink bg-brand-glow px-1.5 py-0.2 rounded border border-brand-solid/20">
          {badge}
        </span>
      )}
    </Link>
  )
}

export function SidebarNavContent({
  hideMain = false,
  className,
  isAdmin,
}: {
  hideMain?: boolean
  className?: string
  isAdmin?: boolean
}) {
  const pathname = usePathname()

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)

  return (
    <nav className={cn('scroll-thin min-h-0 overflow-y-auto px-2.5 py-3 space-y-4', className)}>
      {/* Seção Super Admin (Gestão de Empresas SaaS) */}
      {isAdmin && (
        <div className="space-y-0.5">
          <p className="nav-group-label px-3 mb-1 text-[10px] font-bold uppercase tracking-wider text-amber-400/90 flex items-center justify-between">
            <span>Gestão SaaS (Super Admin)</span>
            <span className="text-[9px] text-amber-400 bg-amber-500/10 px-1.5 py-0.2 rounded border border-amber-500/20">Master</span>
          </p>
          <NavItem
            label="Empresas & Clientes"
            href="/empresas"
            icon={Building2}
            isActive={isActive('/empresas')}
            badge="Admin"
          />
        </div>
      )}

      {/* 1. Atendimento & Pipeline */}
      {!hideMain && (
        <div className="space-y-0.5">
          <p className="nav-group-label px-3 mb-1 text-[10px] font-bold uppercase tracking-wider text-fg-faint">
            <span>Atendimento</span>
          </p>
          {mainNav.map(({ label, href, icon }) => (
            <NavItem key={href} label={label} href={href} icon={icon} isActive={isActive(href)} />
          ))}
        </div>
      )}

      {/* 2. Análise & Métricas */}
      <div className="space-y-0.5">
        <p className="nav-group-label px-3 mb-1 text-[10px] font-bold uppercase tracking-wider text-fg-faint">
          <span>Análise & Métricas</span>
        </p>
        {analyticsNav.map(({ label, href, icon }) => (
          <NavItem key={href} label={label} href={href} icon={icon} isActive={isActive(href)} />
        ))}
      </div>

      {/* 3. Recuperação de Vendas */}
      <div className="space-y-0.5">
        <p className="nav-group-label px-3 mb-1 text-[10px] font-bold uppercase tracking-wider text-fg-faint">
          <span>Recuperação de Vendas</span>
        </p>
        {recoveryNav.map(({ label, href, icon }) => (
          <NavItem key={href} label={label} href={href} icon={icon} isActive={isActive(href)} />
        ))}
      </div>

      {/* 4. API Oficial & Automação */}
      <div className="space-y-0.5">
        <p className="nav-group-label px-3 mb-1 text-[10px] font-bold uppercase tracking-wider text-fg-faint">
          <span>API Oficial & Automação</span>
        </p>
        {automationNav.map(({ label, href, icon }) => (
          <NavItem key={href} label={label} href={href} icon={icon} isActive={isActive(href)} />
        ))}
      </div>

      {/* 5. Sistema */}
      <div className="space-y-0.5">
        <p className="nav-group-label px-3 mb-1 text-[10px] font-bold uppercase tracking-wider text-fg-faint">
          <span>Sistema & Configurações</span>
        </p>
        {bottomNav.map(({ label, href, icon }) => (
          <NavItem key={href} label={label} href={href} icon={icon} isActive={isActive(href)} />
        ))}
      </div>
    </nav>
  )
}

/** Rodapé com Perfil do Stack Auth, Painel de Empresas, tema e sair */
export function SidebarFooter({ isAdmin }: SidebarProps) {
  const user = useUser()

  const displayName = user?.displayName || user?.primaryEmail?.split('@')[0] || 'Usuário'
  const email = user?.primaryEmail || 'Autenticado via Stack Auth'

  return (
    <div className="px-2.5 py-3 border-t border-line-subtle space-y-2 shrink-0 bg-surface-panel">
      {/* Cartão de Perfil do Stack Auth */}
      {user && (
        <div className="flex items-center gap-2.5 p-2 rounded-xl bg-surface-base border border-line-subtle">
          <div className="w-8 h-8 rounded-full bg-brand-glow border border-brand-solid/30 flex items-center justify-center text-brand-ink font-bold text-micro shrink-0 overflow-hidden">
            {user.profileImageUrl ? (
              <img src={user.profileImageUrl} alt={displayName} className="w-full h-full object-cover" />
            ) : (
              displayName.slice(0, 2).toUpperCase()
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <span className="text-micro font-bold text-fg truncate">{displayName}</span>
              {isAdmin && (
                <span className="text-[9px] uppercase font-bold text-amber-400 bg-amber-500/10 px-1 py-0.2 rounded border border-amber-500/20">
                  Super Admin
                </span>
              )}
            </div>
            <p className="text-[11px] text-fg-faint truncate font-mono">{email}</p>
          </div>
        </div>
      )}

      <div className="space-y-0.5">
        {isAdmin && (
          <Link
            href="/empresas"
            title="Painel de Todas as Empresas / Clientes"
            className="nav-item focus-ring flex items-center gap-2.5 px-3 py-2 rounded-[var(--r-md)] text-[0.8125rem] font-medium text-[var(--st-atencao)] hover:bg-[var(--line-subtle)] transition-colors duration-150 ease-out w-full cursor-pointer"
          >
            <Building2 size={15} className="shrink-0" />
            <span className="nav-label">🏢 Alternar Empresa</span>
          </Link>
        )}
        <ThemeToggle />
        <button
          onClick={() => user?.signOut()}
          title="Sair da Conta"
          className="nav-item focus-ring flex items-center gap-2.5 px-3 py-2 rounded-[var(--r-md)] text-fg-subtle hover:text-fg hover:bg-[var(--line-subtle)] transition-colors duration-150 ease-out w-full text-[0.8125rem] cursor-pointer"
        >
          <LogOut size={15} className="shrink-0" />
          <span className="nav-label">Sair da Conta</span>
        </button>
      </div>
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
      <span className="nav-brand-text text-fg text-h3 font-semibold tracking-tight">SAC Hermes</span>
    </div>
  )
}

export function Sidebar({ isAdmin }: SidebarProps) {
  return (
    <aside
      className={cn(
        'sidebar-rail hidden lg:grid h-full shrink-0 border-r border-line-subtle bg-surface-panel',
        'w-16 xl:w-[248px] 2xl:w-[272px]',
        'grid-rows-[auto_1fr_auto]'
      )}
    >
      <div className="nav-brand px-4 h-14 flex items-center border-b border-line-subtle">
        <SidebarBrand />
      </div>

      <SidebarNavContent isAdmin={isAdmin} />

      <SidebarFooter isAdmin={isAdmin} />
    </aside>
  )
}
