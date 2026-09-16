'use client'

import { useState, useEffect, Fragment } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Activity,
  MessageSquare,
  Columns3,
  Users,
  BarChart3,
  Radio,
  Globe,
  Zap,
  Layers,
  Settings,
  Webhook,
  BookOpen,
  Building2,
  LogOut,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  Bot,
} from 'lucide-react'
import { useUser } from '@stackframe/stack'
import { ThemeToggle } from '@/components/theme-toggle'
import { cn } from '@/lib/utils'

export interface ActiveConnections {
  hotmart?: boolean
  kiwify?: boolean
  greenn?: boolean
  zouti?: boolean
  instagram?: boolean
  mineracao?: boolean
}

export function MetaInfinityIcon({ size = 15, className = 'text-sky-400' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={cn('shrink-0', className)}>
      <path d="M18.178 8c5.096 0 5.096 8 0 8-5.095 0-7.26-8-12.355-8-5.096 0-5.096 8 0 8 5.095 0 7.26-8 12.355-8z" />
    </svg>
  )
}

export function HotmartLogoIcon({ size = 15, className = 'text-orange-500' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn('shrink-0', className)}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="currentColor" fillOpacity="0.1" />
      <path d="M8.5 8v8M15.5 8v8M8.5 12h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function KiwifyLogoIcon({ size = 15, className = 'text-cyan-400' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn('shrink-0', className)}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="currentColor" fillOpacity="0.1" />
      <path d="M8.5 8v8M15 8.5l-5 4.5 5.5 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function GreennLogoIcon({ size = 15, className = 'text-emerald-400' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn('shrink-0', className)}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="currentColor" fillOpacity="0.1" />
      <path d="M12 7c-3 0-5 2-5 5 0 3.5 3 6 5 6s5-2.5 5-6c0-3-2-5-5-5zm0 2v7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function ZoutiLogoIcon({ size = 15, className = 'text-purple-400' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn('shrink-0', className)}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="currentColor" fillOpacity="0.1" />
      <path d="M8.5 8.5h7l-7 7h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function InstagramLogoIcon({ size = 15, className = 'text-pink-400' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={cn('shrink-0', className)}>
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5" />
    </svg>
  )
}

export function MineracaoLogoIcon({ size = 15, className = 'text-amber-400' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={cn('shrink-0', className)}>
      <path d="m14 7 3-3 4 4-3 3" />
      <path d="m2 22 9-9" />
      <path d="M12 10a5 5 0 0 0-4-4l-4 4a5 5 0 0 0 4 4l4-4z" />
    </svg>
  )
}

export const atendimentoNav = [
  { label: 'Visão geral', href: '/', icon: Activity },
  { label: 'Conversas', href: '/inbox', icon: MessageSquare },
  { label: 'Pipeline', href: '/pipeline', icon: Columns3 },
  { label: 'Leads Recentes', href: '/leads', icon: Users },
]

export const analiseNav = [
  { label: 'Analytics Vendas', href: '/analytics-vendas', icon: BarChart3 },
  { label: 'Canais de Atendimento', href: '/canais', icon: Radio },
  { label: 'Origens de Tráfego', href: '/origens', icon: Globe },
  { label: 'Operação & SLA', href: '/operacao', icon: Zap },
  { label: 'Recuperador Admin', href: '/recuperador-admin', icon: Layers },
]

export const apiOficialNav = [
  { label: 'Mensagens aprovadas', href: '/api-modelos' },
  { label: 'Campanhas ativas', href: '/api-campanhas' },
  { label: 'Follow-up', href: '/api-followup' },
]

export const hotmartNav = [
  { label: 'Carrinho abandonado', href: '/carrinho' },
  { label: 'Boleto Bancário', href: '/boleto' },
  { label: 'Pix Pendente', href: '/pix' },
  { label: 'Cartão recusado', href: '/cartao-recusado' },
  { label: 'Compra aprovada', href: '/compra-aprovada' },
]

export const kiwifyNav = [
  { label: 'Carrinho Kiwify', href: '/carrinho' },
  { label: 'Boleto Kiwify', href: '/boleto' },
  { label: 'Pix Kiwify', href: '/pix' },
  { label: 'Cartão Kiwify', href: '/cartao-recusado' },
  { label: 'Compra aprovada', href: '/compra-aprovada' },
]

export const greennNav = [
  { label: 'Carrinho Greenn', href: '/carrinho' },
  { label: 'Boleto Greenn', href: '/boleto' },
  { label: 'Pix Greenn', href: '/pix' },
  { label: 'Cartão Greenn', href: '/cartao-recusado' },
  { label: 'Compra aprovada', href: '/compra-aprovada' },
]

export const zoutiNav = [
  { label: 'Carrinho Zouti', href: '/carrinho' },
  { label: 'Boleto Zouti', href: '/boleto' },
  { label: 'Pix Zouti', href: '/pix' },
  { label: 'Cartão Zouti', href: '/cartao-recusado' },
  { label: 'Compra aprovada', href: '/compra-aprovada' },
]

export const instagramNav = [
  { label: 'Conversas Direct', href: '/inbox' },
  { label: 'Leads Instagram', href: '/leads' },
  { label: 'Performance Direct', href: '/origens' },
]

export const mineracaoNav = [
  { label: 'Leads Minerados', href: '/leads' },
  { label: 'Canais de Mineração', href: '/origens' },
  { label: 'Pipeline Prospecção', href: '/pipeline' },
]

export const ajustesNav = [
  { label: 'Configuração', href: '/configuracoes', icon: Settings },
  { label: 'Webhooks Log', href: '/webhooks-log', icon: Webhook },
  { label: 'Biblioteca', href: '/biblioteca', icon: BookOpen },
]

export interface SidebarProps {
  isAdmin?: boolean
  activeConnections?: ActiveConnections
}

export function SidebarBrand({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <div className={cn('flex items-center', collapsed ? 'justify-center w-full' : 'gap-3')}>
      <div className="w-9 h-9 rounded-xl bg-brand-solid flex items-center justify-center font-black text-on-accent text-xs shadow-sm shrink-0">
        CT
      </div>
      {!collapsed && (
        <div className="flex flex-col min-w-0">
          <span className="font-bold text-fg text-sm tracking-tight leading-tight">SAC Casal do Tráfego</span>
          <span className="text-[9px] font-bold tracking-wider text-fg-subtle uppercase">CENTRAL MULTICANAL</span>
        </div>
      )}
    </div>
  )
}

export function SidebarNavContent({
  hideMain = false,
  className,
  isAdmin,
  collapsed = false,
  activeConnections,
}: {
  hideMain?: boolean
  className?: string
  isAdmin?: boolean
  collapsed?: boolean
  activeConnections?: ActiveConnections
}) {
  const pathname = usePathname()

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href)

  // Estado de recolhimento de cada seção da sidebar
  const [sectionsOpen, setSectionsOpen] = useState<{ [key: string]: boolean }>({
    atendimento: true,
    analise: false,
    api_oficial: true,
    hotmart: true,
    kiwify: true,
    greenn: true,
    zouti: true,
    instagram: true,
    mineracao: true,
    ajustes: true,
  })

  // Garantir que a seção ativa esteja sempre aberta
  useEffect(() => {
    if (analiseNav.some(item => isActive(item.href))) {
      setSectionsOpen(prev => ({ ...prev, analise: true }))
    }
    if (apiOficialNav.some(item => isActive(item.href))) {
      setSectionsOpen(prev => ({ ...prev, api_oficial: true }))
    }
    if (hotmartNav.some(item => isActive(item.href))) {
      setSectionsOpen(prev => ({ ...prev, hotmart: true, kiwify: true, greenn: true, zouti: true }))
    }
    if (ajustesNav.some(item => isActive(item.href))) {
      setSectionsOpen(prev => ({ ...prev, ajustes: true }))
    }
  }, [pathname])

  const toggleSection = (key: string) => {
    setSectionsOpen(prev => ({ ...prev, [key]: !prev[key] }))
  }

  // Se nenhuma conexão foi explicitamente configurada, o fallback exibe Hotmart
  const showHotmart = activeConnections?.hotmart ?? true
  const showKiwify = !!activeConnections?.kiwify
  const showGreenn = !!activeConnections?.greenn
  const showZouti = !!activeConnections?.zouti
  const showInstagram = !!activeConnections?.instagram
  const showMineracao = !!activeConnections?.mineracao

  return (
    <nav className={cn('scroll-thin min-h-0 overflow-y-auto px-2 py-3 space-y-3', className)}>
      {/* Super Admin */}
      {isAdmin && (
        <div className="space-y-1">
          {!collapsed ? (
            <div className="flex items-center justify-between px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-500 dark:text-amber-400 font-semibold">
              <span>Gestão SaaS</span>
              <span className="text-[9px] text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.2 rounded border border-amber-500/20 font-bold">Master</span>
            </div>
          ) : (
            <div className="h-px bg-amber-500/20 my-2 mx-1" />
          )}
          <Link
            href="/empresas"
            title="Empresas & Clientes"
            className={cn(
              'nav-item group flex items-center rounded-xl transition-all duration-150 cursor-pointer',
              collapsed ? 'justify-center w-10 h-10 mx-auto px-0' : 'justify-between px-3 py-2 text-[0.8125rem]',
              isActive('/empresas')
                ? 'bg-surface-raised text-amber-600 dark:text-amber-400 font-semibold shadow-sm'
                : 'text-fg-subtle hover:text-fg hover:bg-surface-raised'
            )}
          >
            <div className={cn('flex items-center min-w-0', collapsed ? 'justify-center' : 'gap-2.5')}>
              <Building2 size={16} className={cn('shrink-0', isActive('/empresas') ? 'text-amber-500 dark:text-amber-400' : 'text-fg-faint')} />
              {!collapsed && <span className="truncate">Empresas & Clientes</span>}
            </div>
          </Link>
        </div>
      )}

      {/* 1. SEÇÃO ATENDIMENTO */}
      {!hideMain && (
        <div className="space-y-1">
          {!collapsed ? (
            <button
              type="button"
              onClick={() => toggleSection('atendimento')}
              className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-fg-subtle hover:text-fg transition-colors group cursor-pointer"
            >
              <span>Atendimento</span>
              <ChevronDown
                size={13}
                className={cn('text-fg-faint group-hover:text-fg-muted transition-transform duration-200', !sectionsOpen.atendimento && '-rotate-90')}
              />
            </button>
          ) : (
            <div className="h-px bg-line-subtle my-2 mx-1" />
          )}

          {(collapsed || sectionsOpen.atendimento) && (
            <div className="space-y-0.5">
              {atendimentoNav.map(({ label, href, icon: Icon }) => {
                const active = isActive(href)
                return (
                  <Link
                    key={href}
                    href={href}
                    title={label}
                    className={cn(
                      'nav-item group flex items-center rounded-xl transition-all duration-150 cursor-pointer',
                      collapsed ? 'justify-center w-10 h-10 mx-auto px-0' : 'justify-between px-3 py-2 text-[0.8125rem]',
                      active
                        ? 'bg-surface-raised text-fg font-semibold shadow-sm border border-line-subtle/60'
                        : 'text-fg-muted hover:text-fg hover:bg-surface-raised/60'
                    )}
                  >
                    <div className={cn('flex items-center min-w-0', collapsed ? 'justify-center' : 'gap-2.5')}>
                      <Icon
                        size={15}
                        className={cn(
                          'shrink-0 transition-colors',
                          active ? 'text-brand-ink font-bold' : 'text-fg-faint group-hover:text-fg-muted'
                        )}
                      />
                      {!collapsed && <span className="truncate">{label}</span>}
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 2. SEÇÃO ANÁLISE */}
      <div className="space-y-1">
        {!collapsed ? (
          <button
            type="button"
            onClick={() => toggleSection('analise')}
            className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-fg-subtle hover:text-fg transition-colors group cursor-pointer"
          >
            <span>Análise</span>
            <ChevronDown
              size={13}
              className={cn('text-fg-faint group-hover:text-fg-muted transition-transform duration-200', !sectionsOpen.analise && '-rotate-90')}
            />
          </button>
        ) : (
          <div className="h-px bg-line-subtle my-2 mx-1" />
        )}

        {(collapsed || sectionsOpen.analise) && (
          <div className="space-y-0.5">
            {analiseNav.map(({ label, href, icon: Icon }) => {
              const active = isActive(href)
              return (
                <Link
                  key={href}
                  href={href}
                  title={label}
                  className={cn(
                    'nav-item group flex items-center rounded-xl transition-all duration-150 cursor-pointer',
                    collapsed ? 'justify-center w-10 h-10 mx-auto px-0' : 'justify-between px-3 py-2 text-[0.8125rem]',
                    active
                      ? 'bg-surface-raised text-fg font-semibold shadow-sm border border-line-subtle/60'
                      : 'text-fg-muted hover:text-fg hover:bg-surface-raised/60'
                  )}
                >
                  <div className={cn('flex items-center min-w-0', collapsed ? 'justify-center' : 'gap-2.5')}>
                    <Icon
                      size={15}
                      className={cn(
                        'shrink-0 transition-colors',
                        active ? 'text-brand-ink font-bold' : 'text-fg-faint group-hover:text-fg-muted'
                      )}
                    />
                    {!collapsed && <span className="truncate">{label}</span>}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>

      {/* 3. SEÇÃO API OFICIAL (META & UAZAPI) - Sempre visível */}
      <div className="space-y-1">
        {!collapsed ? (
          <button
            type="button"
            onClick={() => toggleSection('api_oficial')}
            className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-fg-subtle hover:text-fg transition-colors group cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <MetaInfinityIcon size={14} className="text-sky-500 dark:text-sky-400" />
              <span>API Oficial</span>
            </div>
            <ChevronDown
              size={13}
              className={cn('text-fg-faint group-hover:text-fg-muted transition-transform duration-200', !sectionsOpen.api_oficial && '-rotate-90')}
            />
          </button>
        ) : (
          <div className="h-px bg-line-subtle my-2 mx-1" />
        )}

        {(collapsed || sectionsOpen.api_oficial) && (
          <div className={cn('space-y-0.5', !collapsed && 'border-l-2 border-sky-500/80 ml-3 pl-2.5')}>
            {apiOficialNav.map(({ label, href }) => {
              const active = isActive(href)
              return (
                <Link
                  key={href}
                  href={href}
                  title={label}
                  className={cn(
                    'nav-item group flex items-center rounded-lg transition-all duration-150 cursor-pointer',
                    collapsed ? 'justify-center w-10 h-10 mx-auto px-0' : 'justify-between px-2.5 py-1.5 text-[0.8125rem]',
                    active
                      ? 'bg-surface-raised text-fg font-semibold'
                      : 'text-fg-muted hover:text-fg hover:bg-surface-raised/50'
                  )}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', active ? 'bg-sky-500 dark:bg-sky-400' : 'bg-fg-faint')} />
                    {!collapsed && <span className="truncate">{label}</span>}
                  </div>
                  {!collapsed && <span className="h-1.5 w-1.5 rounded-full bg-amber-500/90 dark:bg-amber-400/90 shrink-0" />}
                </Link>
              )
            })}
          </div>
        )}
      </div>

      {/* 4. SEÇÃO HOTMART (Se ativa) */}
      {showHotmart && (
        <div className="space-y-1">
          {!collapsed ? (
            <button
              type="button"
              onClick={() => toggleSection('hotmart')}
              className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-fg-subtle hover:text-fg transition-colors group cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <HotmartLogoIcon size={14} className="text-orange-500" />
                <span>Hotmart</span>
              </div>
              <ChevronDown
                size={13}
                className={cn('text-fg-faint group-hover:text-fg-muted transition-transform duration-200', !sectionsOpen.hotmart && '-rotate-90')}
              />
            </button>
          ) : (
            <div className="h-px bg-line-subtle my-2 mx-1" />
          )}

          {(collapsed || sectionsOpen.hotmart) && (
            <div className={cn('space-y-0.5', !collapsed && 'border-l-2 border-orange-500/80 ml-3 pl-2.5')}>
              {hotmartNav.map(({ label, href }) => {
                const active = isActive(href)
                return (
                  <Link
                    key={href}
                    href={href}
                    title={label}
                    className={cn(
                      'nav-item group flex items-center rounded-lg transition-all duration-150 cursor-pointer',
                      collapsed ? 'justify-center w-10 h-10 mx-auto px-0' : 'justify-between px-2.5 py-1.5 text-[0.8125rem]',
                      active
                        ? 'bg-surface-raised text-fg font-semibold'
                        : 'text-fg-muted hover:text-fg hover:bg-surface-raised/50'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', active ? 'bg-orange-500 dark:bg-orange-400' : 'bg-fg-faint')} />
                      {!collapsed && <span className="truncate">{label}</span>}
                    </div>
                    {!collapsed && <span className="h-1.5 w-1.5 rounded-full bg-amber-500/90 dark:bg-amber-400/90 shrink-0" />}
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 5. SEÇÃO KIWIFY (Se ativa) */}
      {showKiwify && (
        <div className="space-y-1">
          {!collapsed ? (
            <button
              type="button"
              onClick={() => toggleSection('kiwify')}
              className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-fg-subtle hover:text-fg transition-colors group cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <KiwifyLogoIcon size={14} className="text-cyan-500 dark:text-cyan-400" />
                <span>Kiwify</span>
              </div>
              <ChevronDown
                size={13}
                className={cn('text-fg-faint group-hover:text-fg-muted transition-transform duration-200', !sectionsOpen.kiwify && '-rotate-90')}
              />
            </button>
          ) : (
            <div className="h-px bg-line-subtle my-2 mx-1" />
          )}

          {(collapsed || sectionsOpen.kiwify) && (
            <div className={cn('space-y-0.5', !collapsed && 'border-l-2 border-cyan-500/80 ml-3 pl-2.5')}>
              {kiwifyNav.map(({ label, href }) => {
                const active = isActive(href)
                return (
                  <Link
                    key={href}
                    href={href}
                    title={label}
                    className={cn(
                      'nav-item group flex items-center rounded-lg transition-all duration-150 cursor-pointer',
                      collapsed ? 'justify-center w-10 h-10 mx-auto px-0' : 'justify-between px-2.5 py-1.5 text-[0.8125rem]',
                      active
                        ? 'bg-surface-raised text-fg font-semibold'
                        : 'text-fg-muted hover:text-fg hover:bg-surface-raised/50'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', active ? 'bg-cyan-500 dark:bg-cyan-400' : 'bg-fg-faint')} />
                      {!collapsed && <span className="truncate">{label}</span>}
                    </div>
                    {!collapsed && <span className="h-1.5 w-1.5 rounded-full bg-amber-500/90 dark:bg-amber-400/90 shrink-0" />}
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 6. SEÇÃO GREENN (Se ativa) */}
      {showGreenn && (
        <div className="space-y-1">
          {!collapsed ? (
            <button
              type="button"
              onClick={() => toggleSection('greenn')}
              className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-fg-subtle hover:text-fg transition-colors group cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <GreennLogoIcon size={14} className="text-emerald-500 dark:text-emerald-400" />
                <span>Greenn</span>
              </div>
              <ChevronDown
                size={13}
                className={cn('text-fg-faint group-hover:text-fg-muted transition-transform duration-200', !sectionsOpen.greenn && '-rotate-90')}
              />
            </button>
          ) : (
            <div className="h-px bg-line-subtle my-2 mx-1" />
          )}

          {(collapsed || sectionsOpen.greenn) && (
            <div className={cn('space-y-0.5', !collapsed && 'border-l-2 border-emerald-500/80 ml-3 pl-2.5')}>
              {greennNav.map(({ label, href }) => {
                const active = isActive(href)
                return (
                  <Link
                    key={href}
                    href={href}
                    title={label}
                    className={cn(
                      'nav-item group flex items-center rounded-lg transition-all duration-150 cursor-pointer',
                      collapsed ? 'justify-center w-10 h-10 mx-auto px-0' : 'justify-between px-2.5 py-1.5 text-[0.8125rem]',
                      active
                        ? 'bg-surface-raised text-fg font-semibold'
                        : 'text-fg-muted hover:text-fg hover:bg-surface-raised/50'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', active ? 'bg-emerald-500 dark:bg-emerald-400' : 'bg-fg-faint')} />
                      {!collapsed && <span className="truncate">{label}</span>}
                    </div>
                    {!collapsed && <span className="h-1.5 w-1.5 rounded-full bg-amber-500/90 dark:bg-amber-400/90 shrink-0" />}
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 7. SEÇÃO ZOUTI (Se ativa) */}
      {showZouti && (
        <div className="space-y-1">
          {!collapsed ? (
            <button
              type="button"
              onClick={() => toggleSection('zouti')}
              className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-fg-subtle hover:text-fg transition-colors group cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <ZoutiLogoIcon size={14} className="text-purple-500 dark:text-purple-400" />
                <span>Zouti</span>
              </div>
              <ChevronDown
                size={13}
                className={cn('text-fg-faint group-hover:text-fg-muted transition-transform duration-200', !sectionsOpen.zouti && '-rotate-90')}
              />
            </button>
          ) : (
            <div className="h-px bg-line-subtle my-2 mx-1" />
          )}

          {(collapsed || sectionsOpen.zouti) && (
            <div className={cn('space-y-0.5', !collapsed && 'border-l-2 border-purple-500/80 ml-3 pl-2.5')}>
              {zoutiNav.map(({ label, href }) => {
                const active = isActive(href)
                return (
                  <Link
                    key={href}
                    href={href}
                    title={label}
                    className={cn(
                      'nav-item group flex items-center rounded-lg transition-all duration-150 cursor-pointer',
                      collapsed ? 'justify-center w-10 h-10 mx-auto px-0' : 'justify-between px-2.5 py-1.5 text-[0.8125rem]',
                      active
                        ? 'bg-surface-raised text-fg font-semibold'
                        : 'text-fg-muted hover:text-fg hover:bg-surface-raised/50'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', active ? 'bg-purple-500 dark:bg-purple-400' : 'bg-fg-faint')} />
                      {!collapsed && <span className="truncate">{label}</span>}
                    </div>
                    {!collapsed && <span className="h-1.5 w-1.5 rounded-full bg-amber-500/90 dark:bg-amber-400/90 shrink-0" />}
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 8. SEÇÃO INSTAGRAM DIRECT (Se ativa) */}
      {showInstagram && (
        <div className="space-y-1">
          {!collapsed ? (
            <button
              type="button"
              onClick={() => toggleSection('instagram')}
              className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-fg-subtle hover:text-fg transition-colors group cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <InstagramLogoIcon size={14} className="text-pink-500 dark:text-pink-400" />
                <span>Instagram</span>
              </div>
              <ChevronDown
                size={13}
                className={cn('text-fg-faint group-hover:text-fg-muted transition-transform duration-200', !sectionsOpen.instagram && '-rotate-90')}
              />
            </button>
          ) : (
            <div className="h-px bg-line-subtle my-2 mx-1" />
          )}

          {(collapsed || sectionsOpen.instagram) && (
            <div className={cn('space-y-0.5', !collapsed && 'border-l-2 border-pink-500/80 ml-3 pl-2.5')}>
              {instagramNav.map(({ label, href }) => {
                const active = isActive(href)
                return (
                  <Link
                    key={href}
                    href={href}
                    title={label}
                    className={cn(
                      'nav-item group flex items-center rounded-lg transition-all duration-150 cursor-pointer',
                      collapsed ? 'justify-center w-10 h-10 mx-auto px-0' : 'justify-between px-2.5 py-1.5 text-[0.8125rem]',
                      active
                        ? 'bg-surface-raised text-fg font-semibold'
                        : 'text-fg-muted hover:text-fg hover:bg-surface-raised/50'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', active ? 'bg-pink-500 dark:bg-pink-400' : 'bg-fg-faint')} />
                      {!collapsed && <span className="truncate">{label}</span>}
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 9. SEÇÃO MINERAÇÃO & PROSPECÇÃO (Se ativa) */}
      {showMineracao && (
        <div className="space-y-1">
          {!collapsed ? (
            <button
              type="button"
              onClick={() => toggleSection('mineracao')}
              className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-fg-subtle hover:text-fg transition-colors group cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <MineracaoLogoIcon size={14} className="text-amber-500 dark:text-amber-400" />
                <span>Mineração</span>
              </div>
              <ChevronDown
                size={13}
                className={cn('text-fg-faint group-hover:text-fg-muted transition-transform duration-200', !sectionsOpen.mineracao && '-rotate-90')}
              />
            </button>
          ) : (
            <div className="h-px bg-line-subtle my-2 mx-1" />
          )}

          {(collapsed || sectionsOpen.mineracao) && (
            <div className={cn('space-y-0.5', !collapsed && 'border-l-2 border-amber-500/80 ml-3 pl-2.5')}>
              {mineracaoNav.map(({ label, href }) => {
                const active = isActive(href)
                return (
                  <Link
                    key={href}
                    href={href}
                    title={label}
                    className={cn(
                      'nav-item group flex items-center rounded-lg transition-all duration-150 cursor-pointer',
                      collapsed ? 'justify-center w-10 h-10 mx-auto px-0' : 'justify-between px-2.5 py-1.5 text-[0.8125rem]',
                      active
                        ? 'bg-surface-raised text-fg font-semibold'
                        : 'text-fg-muted hover:text-fg hover:bg-surface-raised/50'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', active ? 'bg-amber-500 dark:bg-amber-400' : 'bg-fg-faint')} />
                      {!collapsed && <span className="truncate">{label}</span>}
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* 10. SEÇÃO AJUSTES */}
      <div className="space-y-1">
        {!collapsed ? (
          <button
            type="button"
            onClick={() => toggleSection('ajustes')}
            className="w-full flex items-center justify-between px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider text-fg-subtle hover:text-fg transition-colors group cursor-pointer"
          >
            <span>Ajustes</span>
            <ChevronDown
              size={13}
              className={cn('text-fg-faint group-hover:text-fg-muted transition-transform duration-200', !sectionsOpen.ajustes && '-rotate-90')}
            />
          </button>
        ) : (
          <div className="h-px bg-line-subtle my-2 mx-1" />
        )}

        {(collapsed || sectionsOpen.ajustes) && (
          <div className="space-y-0.5">
            {ajustesNav.map(({ label, href, icon: Icon }) => {
              const active = isActive(href)
              return (
                <Link
                  key={href}
                  href={href}
                  title={label}
                  className={cn(
                    'nav-item group flex items-center rounded-xl transition-all duration-150 cursor-pointer',
                    collapsed ? 'justify-center w-10 h-10 mx-auto px-0' : 'justify-between px-3 py-2 text-[0.8125rem]',
                    active
                      ? 'bg-surface-raised text-fg font-semibold shadow-sm border border-line-subtle/60'
                      : 'text-fg-muted hover:text-fg hover:bg-surface-raised/60'
                  )}
                >
                  <div className={cn('flex items-center min-w-0', collapsed ? 'justify-center' : 'gap-2.5')}>
                    <Icon
                      size={15}
                      className={cn(
                        'shrink-0 transition-colors',
                        active ? 'text-brand-ink font-bold' : 'text-fg-faint group-hover:text-fg-muted'
                      )}
                    />
                    {!collapsed && <span className="truncate">{label}</span>}
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </nav>
  )
}

/** Rodapé com Card de Cliente, Perfil, Tema e LogOut */
export function SidebarFooter({ isAdmin, collapsed = false }: SidebarProps & { collapsed?: boolean }) {
  const user = useUser()

  const displayName = user?.displayName || user?.primaryEmail?.split('@')[0] || 'Usuário'
  const email = user?.primaryEmail || 'Sessão Ativa'

  return (
    <div className={cn('py-3 border-t border-line-subtle space-y-2.5 shrink-0 bg-surface-panel', collapsed ? 'px-1.5' : 'px-2.5')}>
      {/* Card de Cliente / Status de Envio */}
      {!collapsed && (
        <div className="space-y-1.5 px-1">
          <p className="text-[10px] font-bold uppercase tracking-wider text-fg-subtle">Cliente</p>
          <p className="text-[11px] text-fg-faint">Sessão da empresa ativa conectada.</p>
          <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-2.5 space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse shrink-0" />
              <span className="text-[11px] font-bold text-fg">Central Multicanal Ativa</span>
            </div>
            <p className="text-[10px] text-fg-muted leading-tight">
              Mensagens de recuperação e SAC prontas para envio oficial via WhatsApp.
            </p>
          </div>
        </div>
      )}

      {/* Cartão de Perfil do Stack Auth */}
      {user && (
        <div className={cn('flex items-center rounded-xl bg-surface-base border border-line-subtle', collapsed ? 'justify-center p-1.5' : 'gap-2.5 p-2')}>
          <div className="w-8 h-8 rounded-full bg-brand-glow border border-brand-solid/30 flex items-center justify-center text-brand-ink font-bold text-micro shrink-0 overflow-hidden" title={`${displayName} (${email})`}>
            {user.profileImageUrl ? (
              <img src={user.profileImageUrl} alt={displayName} className="w-full h-full object-cover" />
            ) : (
              displayName.slice(0, 2).toUpperCase()
            )}
          </div>
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="text-micro font-bold text-fg truncate">{displayName}</span>
                {isAdmin && (
                  <span className="text-[9px] uppercase font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1 py-0.2 rounded border border-amber-500/20">
                    Admin
                  </span>
                )}
              </div>
              <p className="text-[11px] text-fg-faint truncate font-mono">{email}</p>
            </div>
          )}
        </div>
      )}

      <div className="space-y-0.5">
        {!collapsed ? (
          <ThemeToggle />
        ) : (
          <div className="flex justify-center py-1">
            <ThemeToggle />
          </div>
        )}

        <button
          onClick={() => user?.signOut()}
          title="Sair da Conta"
          className={cn(
            'nav-item focus-ring flex items-center rounded-[var(--r-md)] text-fg-subtle hover:text-fg hover:bg-surface-raised transition-colors duration-150 ease-out text-[0.8125rem] cursor-pointer',
            collapsed ? 'justify-center w-10 h-10 mx-auto' : 'gap-2.5 px-3 py-2 w-full'
          )}
        >
          <LogOut size={16} className="shrink-0" />
          {!collapsed && <span className="nav-label">Sair da Conta</span>}
        </button>
      </div>
    </div>
  )
}

export function Sidebar({ isAdmin, activeConnections }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    const saved = localStorage.getItem('sac_sidebar_collapsed')
    if (saved === 'true') {
      setCollapsed(true)
    }
  }, [])

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev
      localStorage.setItem('sac_sidebar_collapsed', String(next))
      return next
    })
  }

  return (
    <aside
      className={cn(
        'sidebar-rail hidden lg:grid h-full shrink-0 border-r border-line-subtle bg-surface-panel transition-all duration-200 ease-in-out relative',
        collapsed ? 'w-[68px]' : 'w-[252px]',
        'grid-rows-[auto_1fr_auto]'
      )}
    >
      <div className={cn('nav-brand h-16 flex items-center border-b border-line-subtle px-3 relative', collapsed ? 'justify-center' : 'justify-between')}>
        <div className={cn('flex items-center', collapsed ? 'justify-center w-full' : 'gap-3')}>
          <div
            onClick={collapsed ? toggleCollapsed : undefined}
            className={cn(
              'w-9 h-9 rounded-xl bg-brand-solid flex items-center justify-center font-black text-on-accent text-base shadow-sm shrink-0',
              collapsed && 'cursor-pointer hover:opacity-90 transition-opacity'
            )}
            title={collapsed ? 'Clique para expandir o menu' : undefined}
          >
            CT
          </div>
          {!collapsed && (
            <div className="flex flex-col min-w-0">
              <span className="font-bold text-fg text-sm tracking-tight leading-tight">SAC Casal do Tráfego</span>
              <span className="text-[9px] font-bold tracking-wider text-fg-subtle uppercase">CENTRAL MULTICANAL</span>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? 'Expandir Menu' : 'Recolher Menu'}
          className={cn(
            'text-fg-faint hover:text-fg hover:bg-surface-raised p-1.5 rounded-lg transition-colors cursor-pointer shrink-0',
            collapsed && 'absolute -right-3 top-5 bg-surface-panel border border-line-subtle rounded-full shadow-md z-30 p-1 text-fg hover:bg-surface-raised'
          )}
        >
          {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={16} />}
        </button>
      </div>

      <SidebarNavContent isAdmin={isAdmin} collapsed={collapsed} activeConnections={activeConnections} />

      <SidebarFooter isAdmin={isAdmin} collapsed={collapsed} />
    </aside>
  )
}
