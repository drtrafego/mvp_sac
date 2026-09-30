// Brasil não tem horário de verão (UTC-3)
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000

export function todayBrt(): string {
  return new Date(Date.now() - BRT_OFFSET_MS).toISOString().split('T')[0]!
}

function dateBrt(now: Date): string {
  return new Date(now.getTime() - BRT_OFFSET_MS).toISOString().split('T')[0]!
}

function partsOf(iso: string): { year: number; month: number; day: number } {
  const [y, m, d] = iso.split('-').map(Number)
  return { year: y!, month: m!, day: d! }
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export function startOfMonth(iso: string): string {
  const { year, month } = partsOf(iso)
  return `${year}-${pad(month)}-01`
}

export function endOfMonth(iso: string): string {
  const { year, month } = partsOf(iso)
  return `${year}-${pad(month)}-${pad(lastDayOfMonth(year, month))}`
}

export type Period = { from: string; to: string }

function addDays(iso: string, days: number): string {
  const { year, month, day } = partsOf(iso)
  const d = new Date(Date.UTC(year, month - 1, day + days))
  return d.toISOString().slice(0, 10)
}

// Resolve o período a partir dos parâmetros de busca (?from=...&to=...)
export function resolvePeriod(params: {
  from?: string
  to?: string
  period?: string
  now?: Date
}): Period {
  if (params.from && params.to) return { from: params.from, to: params.to }

  const hoje = params.now ? dateBrt(params.now) : todayBrt()
  switch (params.period) {
    case 'today':
      return { from: hoje, to: hoje }
    case 'yesterday': {
      const ontem = addDays(hoje, -1)
      return { from: ontem, to: ontem }
    }
    case '7d':
      return { from: addDays(hoje, -6), to: hoje }
    case '14d':
      return { from: addDays(hoje, -13), to: hoje }
    case 'month':
      return { from: startOfMonth(hoje), to: hoje }
    case 'all':
      return { from: '2026-01-01', to: hoje }
    case 'custom':
      if (params.from) return { from: params.from, to: params.to ?? hoje }
      break
  }

  return { from: addDays(hoje, -29), to: hoje }
}
