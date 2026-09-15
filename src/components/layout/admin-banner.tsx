'use client'

import { useState, useEffect, useRef } from 'react'
import { Building2, ChevronDown, Check, Plus, Bot, Layers, Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { cn } from '@/lib/utils'

interface Company {
  id: number
  name: string
  slug: string
  plan: string
}

interface AdminBannerProps {
  companyName: string
  companyId: number
}

export function AdminBanner({ companyName, companyId }: AdminBannerProps) {
  const [companies, setCompanies] = useState<Company[]>([])
  const [open, setOpen] = useState(false)
  const [switching, setSwitching] = useState<number | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  useEffect(() => {
    fetch('/api/admin/companies')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setCompanies(data)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  async function handleSelectCompany(id: number) {
    if (id === companyId) {
      setOpen(false)
      return
    }
    setSwitching(id)
    try {
      await fetch(`/api/admin/companies/${id}/enter`, { method: 'POST' })
      setOpen(false)
      router.push('/')
      router.refresh()
    } finally {
      setSwitching(null)
    }
  }

  async function handleExit() {
    await fetch('/api/admin/companies/exit', { method: 'POST' })
    router.push('/empresas')
    router.refresh()
  }

  return (
    <div
      className="relative z-50 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2 text-micro"
      style={{
        background: 'linear-gradient(90deg, #121815 0%, #0d1210 100%)',
        borderColor: 'rgba(34, 197, 94, 0.2)',
      }}
    >
      <div className="flex items-center gap-3" ref={dropdownRef}>
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-solid opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-solid"></span>
          </span>
          <span className="text-fg-subtle text-micro font-medium uppercase tracking-wider">
            Workspace SaaS:
          </span>
        </div>

        {/* Dropdown de Troca Rápida de Agente / Empresa */}
        <div className="relative">
          <button
            onClick={() => setOpen(!open)}
            className="focus-ring inline-flex items-center gap-2 rounded-[var(--r-md)] border border-line-subtle bg-surface-inset px-3 py-1.5 text-micro font-semibold text-fg transition-colors hover:border-brand-solid/40 hover:bg-surface-raised cursor-pointer"
          >
            <Bot size={14} className="text-brand-ink" />
            <span className="max-w-[200px] truncate">{companyName}</span>
            <ChevronDown size={13} className={cn('text-fg-subtle transition-transform duration-200', open && 'rotate-180')} />
          </button>

          {open && (
            <div className="absolute left-0 top-full mt-1.5 w-64 rounded-[var(--r-lg)] border border-line-subtle bg-surface-overlay p-1.5 shadow-2xl backdrop-blur-xl animate-in fade-in-0 zoom-in-95">
              <div className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-fg-faint border-b border-line-subtle mb-1 flex items-center justify-between">
                <span>Alternar Agente / Empresa</span>
                <span className="text-brand-ink font-normal">{companies.length} ativos</span>
              </div>

              <div className="max-h-56 overflow-y-auto space-y-0.5 scroll-thin">
                {companies.map((c) => {
                  const isCurrent = c.id === companyId
                  return (
                    <button
                      key={c.id}
                      onClick={() => handleSelectCompany(c.id)}
                      disabled={switching !== null}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-[var(--r-sm)] px-2.5 py-2 text-left text-micro font-medium transition-colors cursor-pointer',
                        isCurrent
                          ? 'bg-surface-raised text-brand-ink font-semibold'
                          : 'text-fg-subtle hover:bg-surface-inset hover:text-fg'
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', isCurrent ? 'bg-brand-solid' : 'bg-fg-faint')} />
                        <span className="truncate">{c.name}</span>
                      </div>
                      {isCurrent ? (
                        <Check size={13} className="text-brand-ink shrink-0" />
                      ) : (
                        <span className="text-[10px] text-fg-faint uppercase font-normal">{c.plan}</span>
                      )}
                    </button>
                  )
                })}
              </div>

              <div className="border-t border-line-subtle pt-1 mt-1 space-y-0.5">
                <Link
                  href="/empresas"
                  onClick={() => setOpen(false)}
                  className="flex w-full items-center gap-2 rounded-[var(--r-sm)] px-2.5 py-1.5 text-left text-micro text-fg-muted hover:bg-surface-inset hover:text-fg transition-colors"
                >
                  <Plus size={13} className="text-brand-ink" />
                  <span>Cadastrar Novo Agente / Empresa</span>
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Link
          href="/empresas"
          className="focus-ring flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--r-sm)] border border-line-subtle bg-surface-inset px-3 py-1 text-micro font-medium text-fg-muted hover:text-fg hover:border-line-strong transition-colors"
        >
          <Building2 size={13} />
          Painel de Todos os Agentes
        </Link>
      </div>
    </div>
  )
}
