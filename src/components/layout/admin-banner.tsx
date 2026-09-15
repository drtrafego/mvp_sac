'use client'

import { Building2 } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface AdminBannerProps {
  companyName: string
  companyId: number
}

export function AdminBanner({ companyName }: AdminBannerProps) {
  const router = useRouter()

  async function handleExit() {
    await fetch('/api/admin/companies/exit', { method: 'POST' })
    router.push('/empresas')
    router.refresh()
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-micro text-st-atencao"
      style={{
        background: 'color-mix(in oklch, var(--st-atencao) 10%, transparent)',
        borderColor: 'color-mix(in oklch, var(--st-atencao) 22%, transparent)',
      }}
    >
      <span className="min-w-0 truncate font-medium">
        🏢 Empresa selecionada: <strong className="font-bold text-fg">{companyName}</strong>
      </span>
      <button
        onClick={handleExit}
        className="focus-ring flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--r-sm)] px-3 py-1.5 text-micro font-semibold text-st-atencao hover:text-white transition-colors"
        style={{ background: 'color-mix(in oklch, var(--st-atencao) 20%, transparent)' }}
      >
        <Building2 size={14} />
        Trocar Empresa / Painel Geral
      </button>
    </div>
  )
}
