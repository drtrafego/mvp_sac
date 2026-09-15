'use client'

import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import { X } from 'lucide-react'

const PERIODS = [
  { value: 'today', label: 'Hoje' },
  { value: 'yesterday', label: 'Ontem' },
  { value: '7d', label: '7 dias' },
  { value: '14d', label: '14 dias' },
  { value: '30d', label: '30 dias' },
  { value: 'month', label: 'Este mês' },
  { value: 'all', label: 'Tudo' },
]

/*
  Todos os chips carregam borda, inclusive os não selecionados, com a cor
  transparente. Sem isso a fila inteira andava dois pixels ao trocar de período.
*/
const CHIP_BASE =
  'focus-ring shrink-0 inline-flex items-center justify-center border rounded-[var(--r-md)] px-4 lg:px-3 h-[var(--control-lg)] lg:h-[var(--control-sm)] text-body lg:text-micro font-medium cursor-pointer transition-colors duration-150'

export function DashboardPeriodFilter() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const period = searchParams.get('period') ?? '30d'

  const setPeriod = (value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (value === '30d') params.delete('period')
    else params.set('period', value)
    const qs = params.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  return (
    <div className="scroll-thin flex w-full items-center gap-2 overflow-x-auto pb-1 lg:w-auto lg:flex-wrap lg:overflow-visible lg:pb-0">
      {PERIODS.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => setPeriod(value)}
          aria-pressed={period === value}
          className={`${CHIP_BASE} ${
            period === value
              ? 'bg-surface-overlay border-line-strong text-fg'
              : 'border-transparent text-fg-muted hover:bg-surface-inset hover:text-fg'
          }`}
        >
          {label}
        </button>
      ))}
      {period !== '30d' && (
        <button
          onClick={() => setPeriod('30d')}
          className={`${CHIP_BASE} gap-1.5 border-transparent text-fg-subtle hover:bg-surface-inset hover:text-fg`}
        >
          <X size={13} />
          Limpar
        </button>
      )}
    </div>
  )
}
