// Brasil não tem horário de verão (UTC-3)
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000

export function todayBrt(): string {
  return new Date(Date.now() - BRT_OFFSET_MS).toISOString().split('T')[0]!
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

// Resolve o período a partir dos parâmetros de busca (?from=...&to=...)
export function resolvePeriod(params: {
  from?: string
  to?: string
  period?: string
}): Period {
  if (params.from && params.to) return { from: params.from, to: params.to }

  const hoje = todayBrt()
  return { from: startOfMonth(hoje), to: endOfMonth(hoje) }
}
