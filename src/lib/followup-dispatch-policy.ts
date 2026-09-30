import { AGENDA_DAYS, DEFAULT_AVAILABILITY_SCHEDULE, type AgendaDay, type AvailabilitySchedule } from '@/lib/agenda-schedule'

const WEEKDAY_TO_DAY: Record<string, AgendaDay> = {
  Sun: 'domingo',
  Mon: 'segunda',
  Tue: 'terca',
  Wed: 'quarta',
  Thu: 'quinta',
  Fri: 'sexta',
  Sat: 'sabado',
}

export type DispatchWindowDecision =
  | { allowed: true }
  | { allowed: false; retryAt: Date | null; reason: string }

function timeToMinutes(value: string): number {
  const [hh, mm] = value.split(':').map(Number)
  return hh * 60 + mm
}

function resolveSchedule(schedule: AvailabilitySchedule | null | undefined): AvailabilitySchedule {
  return schedule ?? DEFAULT_AVAILABILITY_SCHEDULE
}

function timezoneOffsetMinutes(timezone: string): number | null {
  const match = /^([+-])(\d{2}):([0-5]\d)$/.exec(timezone)
  if (!match) return null
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3]))
}

function localParts(date: Date, timezone: string): {
  dateKey: string
  day: AgendaDay
  minutes: number
} {
  const offset = timezoneOffsetMinutes(timezone)
  if (offset != null) {
    const local = new Date(date.getTime() + offset * 60_000)
    const weekday = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'][local.getUTCDay()] as AgendaDay
    const year = local.getUTCFullYear()
    const month = String(local.getUTCMonth() + 1).padStart(2, '0')
    const day = String(local.getUTCDate()).padStart(2, '0')
    return {
      dateKey: `${year}-${month}-${day}`,
      day: weekday,
      minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
    }
  }

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''
  const dateKey = `${get('year')}-${get('month')}-${get('day')}`
  const day = WEEKDAY_TO_DAY[get('weekday')] ?? 'segunda'
  return { dateKey, day, minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

function zonedDateTimeToDate(dateKey: string, hhmm: string, timezone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hour, minute] = hhmm.split(':').map(Number)
  const offset = timezoneOffsetMinutes(timezone)
  if (offset != null) {
    return new Date(Date.UTC(year, month - 1, day, hour, minute) - offset * 60_000)
  }

  let utc = new Date(Date.UTC(year, month - 1, day, hour, minute))

  for (let i = 0; i < 2; i++) {
    const seen = localParts(utc, timezone)
    const seenDate = seen.dateKey.split('-').map(Number)
    const desiredDate = Date.UTC(year, month - 1, day)
    const actualDate = Date.UTC(seenDate[0], seenDate[1] - 1, seenDate[2])
    const dayDelta = Math.round((desiredDate - actualDate) / 86_400_000)
    const minuteDelta = dayDelta * 1440 + (hour * 60 + minute) - seen.minutes
    if (minuteDelta === 0) break
    utc = new Date(utc.getTime() + minuteDelta * 60_000)
  }

  return utc
}

function addLocalDays(anchor: Date, days: number, timezone: string): Date {
  const parts = localParts(anchor, timezone)
  const [year, month, day] = parts.dateKey.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + days, 12, 0))
  return next
}

export function evaluateDispatchWindow(params: {
  schedule?: AvailabilitySchedule | null
  blockedDates?: Set<string> | string[]
  now?: Date
  searchDays?: number
}): DispatchWindowDecision {
  const schedule = resolveSchedule(params.schedule)
  const timezone = schedule.timezone || DEFAULT_AVAILABILITY_SCHEDULE.timezone
  const now = params.now ?? new Date()
  const blockedDates = params.blockedDates instanceof Set
    ? params.blockedDates
    : new Set(params.blockedDates ?? [])

  const current = localParts(now, timezone)
  const rangesNow = schedule[current.day] ?? []
  if (!blockedDates.has(current.dateKey)) {
    for (const range of rangesNow) {
      if (timeToMinutes(range.inicio) <= current.minutes && current.minutes < timeToMinutes(range.fim)) {
        return { allowed: true }
      }
    }
  }

  const searchDays = params.searchDays ?? 14
  for (let offset = 0; offset <= searchDays; offset++) {
    const probe = offset === 0 ? now : addLocalDays(now, offset, timezone)
    const { dateKey, day, minutes } = localParts(probe, timezone)
    if (blockedDates.has(dateKey)) continue
    const ranges = [...(schedule[day] ?? [])].sort((a, b) => a.inicio.localeCompare(b.inicio))
    for (const range of ranges) {
      if (offset === 0 && timeToMinutes(range.fim) <= minutes) continue
      const retryAt = zonedDateTimeToDate(dateKey, range.inicio, timezone)
      if (retryAt > now) {
        return { allowed: false, retryAt, reason: 'fora do horário de atendimento' }
      }
    }
  }

  const fallback = new Date(now.getTime() + 24 * 60 * 60_000)
  return { allowed: false, retryAt: fallback, reason: 'sem horário de atendimento disponível nos próximos dias' }
}

export function firstDueJobPerLead<T extends { leadId: number | null; messageOrder?: number | null; id: number }>(jobs: T[]): {
  keep: T[]
  defer: T[]
} {
  const firstByLead = new Map<number, T>()
  const keepWithoutLead: T[] = []

  for (const job of jobs) {
    if (job.leadId == null) {
      keepWithoutLead.push(job)
      continue
    }
    const current = firstByLead.get(job.leadId)
    if (!current) {
      firstByLead.set(job.leadId, job)
      continue
    }
    const curOrder = current.messageOrder ?? -1
    const nextOrder = job.messageOrder ?? -1
    if (nextOrder < curOrder || (nextOrder === curOrder && job.id < current.id)) {
      firstByLead.set(job.leadId, job)
    }
  }

  const selectedIds = new Set([...firstByLead.values(), ...keepWithoutLead].map(job => job.id))
  return {
    keep: jobs.filter(job => selectedIds.has(job.id)),
    defer: jobs.filter(job => !selectedIds.has(job.id)),
  }
}

export function shouldApplyFollowupDispatchWindow(job: {
  massDispatchBatchId?: number | null
  messageOrder?: number | null
  upsellContent?: string | null
}): boolean {
  if (job.massDispatchBatchId != null) return false
  return job.messageOrder != null || Boolean(job.upsellContent)
}

export function hasAnyOpenRange(schedule: AvailabilitySchedule | null | undefined): boolean {
  const resolved = resolveSchedule(schedule)
  return AGENDA_DAYS.some(day => (resolved[day] ?? []).length > 0)
}

export function retryAtAfterPreviousFollowupStep(params: {
  previousSentAt: Date
  previousDelayMinutes: number | null | undefined
  currentDelayMinutes: number | null | undefined
  now?: Date
}): Date | null {
  const now = params.now ?? new Date()
  const previousDelay = Math.max(0, params.previousDelayMinutes ?? 0)
  const currentDelay = Math.max(0, params.currentDelayMinutes ?? 0)
  const spacingMinutes = Math.max(0, currentDelay - previousDelay)
  const retryAt = new Date(params.previousSentAt.getTime() + spacingMinutes * 60_000)
  return retryAt > now ? retryAt : null
}
