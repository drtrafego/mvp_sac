const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/

function hasValidCalendarDate(value: string): boolean {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function parseDate(value: string, boundary: 'start' | 'end'): Date | null {
  if (DATE_ONLY.test(value)) {
    const [year, month, day] = value.split('-').map(Number)
    const parsed = new Date(Date.UTC(year, month - 1, day))

    if (!hasValidCalendarDate(value)) return null

    if (boundary === 'end') parsed.setUTCHours(23, 59, 59, 999)
    return parsed
  }

  if (!ISO_WITH_TIMEZONE.test(value) || !hasValidCalendarDate(value)) return null

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function resolveAnalyticsPeriod(from: string | null, to: string | null, now = new Date()) {
  const toDate = to ? parseDate(to, 'end') : now
  if (!toDate) return { error: 'Parâmetro "to" inválido. Use YYYY-MM-DD ou data ISO 8601 com timezone.' } as const

  const fromDate = from ? parseDate(from, 'start') : new Date(toDate.getTime() - 30 * 24 * 3600 * 1000)
  if (!fromDate) return { error: 'Parâmetro "from" inválido. Use YYYY-MM-DD ou data ISO 8601 com timezone.' } as const

  if (fromDate > toDate) {
    return { error: 'O parâmetro "from" deve ser anterior ou igual a "to".' } as const
  }

  return { fromDate, toDate } as const
}
