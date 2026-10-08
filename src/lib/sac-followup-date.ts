const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Existing Pipeline date-only convention: noon at UTC-03, never UTC midnight. */
export function followupDayToIso(value: string | null | undefined): string | null {
  if (!value) return null
  if (!DAY_PATTERN.test(value)) throw new Error('Data de retorno inválida')
  const date = new Date(`${value}T12:00:00-03:00`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Data de retorno inválida')
  }
  return date.toISOString()
}

export function followupDayKey(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (typeof value === 'string' && DAY_PATTERN.test(value)) {
    followupDayToIso(value)
    return value
  }
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('Data de retorno inválida')
  const parts = dayFormatter.formatToParts(date)
  const part = (type: string) => parts.find(p => p.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
