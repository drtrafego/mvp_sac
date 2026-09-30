// Grade semanal de horário de atendimento (availabilitySchedule em settings.jsonb).
// Compartilhado entre a rota de API (src/app/api/v1/companies/[idOrSlug]/agenda/schedule)
// e a tela do painel (src/app/(dashboard)/configuracoes/agenda). Ver o comentário
// em src/lib/db/schema.ts sobre o campo e o gap que ele fecha.

export const AGENDA_DAYS = ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo'] as const
export type AgendaDay = (typeof AGENDA_DAYS)[number]

export const AGENDA_DAY_LABELS: Record<AgendaDay, string> = {
  segunda: 'Segunda-feira',
  terca: 'Terça-feira',
  quarta: 'Quarta-feira',
  quinta: 'Quinta-feira',
  sexta: 'Sexta-feira',
  sabado: 'Sábado',
  domingo: 'Domingo',
}

export const AGENDA_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
export const AGENDA_TIMEZONE_OFFSET_RE = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/
export const AGENDA_SLOT_MINUTES = [10, 15, 20, 30, 45, 60] as const

// Formato de data (AAAA-MM-DD) usado pelos bloqueios de agenda (agendaBlockedDates).
export const AGENDA_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !AGENDA_DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  if (isNaN(d.getTime())) return false
  // new Date() faz rollover silencioso em datas de calendário inexistentes
  // (2026-02-30 vira 2026-03-02, 2026-04-31 vira 2026-05-01). Reconstruindo a
  // string a partir do Date parseado e comparando com o input, o rollover é
  // detectado aqui em vez de estourar só no INSERT (a coluna DATE do Postgres
  // rejeita, virando 500 em vez do 400 "Data inválida" que já existe).
  return d.toISOString().slice(0, 10) === value
}

export interface DayRange {
  inicio: string
  fim: string
}

export interface AvailabilitySchedule {
  segunda: DayRange[] | null
  terca: DayRange[] | null
  quarta: DayRange[] | null
  quinta: DayRange[] | null
  sexta: DayRange[] | null
  sabado: DayRange[] | null
  domingo: DayRange[] | null
  timezone: string
  duracaoSlotMinutos: number
}

export const NATIVE_AVAILABILITY_COMPANY_SLUGS = ['drlucas', 'gramado-plaza'] as const
export type NativeAvailabilityCompanySlug = (typeof NATIVE_AVAILABILITY_COMPANY_SLUGS)[number]

export function isNativeAvailabilityCompany(slug: string): slug is NativeAvailabilityCompanySlug {
  return NATIVE_AVAILABILITY_COMPANY_SLUGS.includes(slug as NativeAvailabilityCompanySlug)
}

export const NATIVE_AVAILABILITY_SOURCE_LABELS: Record<NativeAvailabilityCompanySlug, string> = {
  drlucas: 'Arquivo nativo do bot (/opt/data/agenda_config.json)',
  'gramado-plaza': 'API de reservas do Gramado Plaza',
}

export const DEFAULT_AVAILABILITY_SCHEDULE: AvailabilitySchedule = {
  segunda: [{ inicio: '08:00', fim: '12:00' }],
  terca: [{ inicio: '08:00', fim: '12:00' }],
  quarta: [{ inicio: '08:00', fim: '12:00' }],
  quinta: [{ inicio: '08:00', fim: '12:00' }],
  sexta: [{ inicio: '08:00', fim: '12:00' }],
  sabado: null,
  domingo: null,
  timezone: 'America/Sao_Paulo',
  duracaoSlotMinutos: 30,
}

export function isValidAgendaTimezone(value: string): boolean {
  if (AGENDA_TIMEZONE_OFFSET_RE.test(value)) return true
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date())
    return true
  } catch {
    return false
  }
}

export function isValidDayRange(value: unknown): value is DayRange {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return AGENDA_TIME_RE.test(String(v.inicio)) && AGENDA_TIME_RE.test(String(v.fim)) && String(v.inicio) < String(v.fim)
}

export function isValidDayRangeList(value: unknown): value is DayRange[] | null {
  return validateDayRangeList(value).ok
}

function validateDayRangeList(value: unknown): { ok: true } | { ok: false; error: string } {
  if (value === null) return { ok: true }
  if (!Array.isArray(value)) return { ok: false, error: 'use uma lista de intervalos ou null' }
  if (value.length === 0) return { ok: true }
  if (value.length > 8) return { ok: false, error: 'use no máximo 8 intervalos por dia' }

  const ranges: DayRange[] = []
  for (const [index, range] of value.entries()) {
    if (!isValidDayRange(range)) {
      return { ok: false, error: `intervalo ${index + 1} deve ter inicio/fim em HH:MM e inicio menor que fim` }
    }
    ranges.push(range)
  }

  const ordered = [...ranges].sort((a, b) => a.inicio.localeCompare(b.inicio))
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i - 1].fim > ordered[i].inicio) {
      return { ok: false, error: 'intervalos não podem se sobrepor' }
    }
  }

  return { ok: true }
}

export function validateAvailabilitySchedule(
  body: unknown
): { ok: true; schedule: AvailabilitySchedule } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Corpo inválido.' }
  const input = body as Record<string, unknown>

  const schedule: Partial<AvailabilitySchedule> = {}
  for (const day of AGENDA_DAYS) {
    const value = input[day]
    if (value === undefined) {
      schedule[day] = DEFAULT_AVAILABILITY_SCHEDULE[day]
      continue
    }
    const rangeValidation = validateDayRangeList(value)
    if (!rangeValidation.ok) {
      return {
        ok: false,
        error: `Horário inválido para "${day}": ${rangeValidation.error}. Use [{ inicio: "HH:MM", fim: "HH:MM" }] ou null.`,
      }
    }
    schedule[day] = Array.isArray(value) && value.length === 0 ? null : value as DayRange[]
  }

  const timezone =
    typeof input.timezone === 'string' && input.timezone.trim() ? input.timezone.trim() : DEFAULT_AVAILABILITY_SCHEDULE.timezone
  if (!isValidAgendaTimezone(timezone)) {
    return { ok: false, error: 'timezone inválido. Use um fuso IANA (ex.: America/Sao_Paulo) ou offset -03:00.' }
  }
  const duracaoSlotMinutos = Number(input.duracaoSlotMinutos ?? DEFAULT_AVAILABILITY_SCHEDULE.duracaoSlotMinutos)
  if (!AGENDA_SLOT_MINUTES.includes(duracaoSlotMinutos as (typeof AGENDA_SLOT_MINUTES)[number])) {
    return { ok: false, error: 'duracaoSlotMinutos precisa ser um destes valores: 10, 15, 20, 30, 45 ou 60.' }
  }

  return { ok: true, schedule: { ...schedule, timezone, duracaoSlotMinutos } as AvailabilitySchedule }
}

// Formato legado usado pelo painel antigo mvp_agente_ia/control API:
// "0"=domingo, "1"=segunda ... "6"=sábado e cada faixa é ["HH:MM","HH:MM"].
export type LegacyAgendaHours = Record<string, [string, string][]>

const LEGACY_DAY_TO_AGENDA_DAY: Record<string, AgendaDay> = {
  '0': 'domingo',
  '1': 'segunda',
  '2': 'terca',
  '3': 'quarta',
  '4': 'quinta',
  '5': 'sexta',
  '6': 'sabado',
}

export function legacyAgendaHoursToAvailabilitySchedule(input: {
  timezone?: string | null
  slotMinutes?: number | null
  hours?: LegacyAgendaHours | null
}): AvailabilitySchedule {
  const slotMinutes = AGENDA_SLOT_MINUTES.includes(input.slotMinutes as (typeof AGENDA_SLOT_MINUTES)[number])
    ? input.slotMinutes!
    : DEFAULT_AVAILABILITY_SCHEDULE.duracaoSlotMinutos
  const schedule: AvailabilitySchedule = {
    segunda: null,
    terca: null,
    quarta: null,
    quinta: null,
    sexta: null,
    sabado: null,
    domingo: null,
    timezone: input.timezone?.trim() || DEFAULT_AVAILABILITY_SCHEDULE.timezone,
    duracaoSlotMinutos: slotMinutes,
  }

  for (const [legacyDay, day] of Object.entries(LEGACY_DAY_TO_AGENDA_DAY)) {
    const ranges = input.hours?.[legacyDay] ?? []
    const normalized = ranges
      .map(([inicio, fim]) => ({ inicio, fim }))
      .filter(isValidDayRange)
    schedule[day] = normalized.length > 0 ? normalized : null
  }

  const validated = validateAvailabilitySchedule(schedule)
  return validated.ok ? validated.schedule : DEFAULT_AVAILABILITY_SCHEDULE
}

export function normalizeAvailabilitySchedule(value: unknown): AvailabilitySchedule | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const normalized: Record<string, unknown> = { ...input }

  // Compatibilidade com duas formas antigas:
  // 1) dia como objeto único { inicio, fim };
  // 2) painel mvp_agente_ia com hours: { "1": [["08:00","12:00"]] }.
  if (input.hours && typeof input.hours === 'object') {
    return legacyAgendaHoursToAvailabilitySchedule({
      timezone: typeof input.timezone === 'string' ? input.timezone : null,
      slotMinutes: Number.isFinite(Number(input.slotMinutes ?? input.slot_minutes))
        ? Number(input.slotMinutes ?? input.slot_minutes)
        : null,
      hours: input.hours as LegacyAgendaHours,
    })
  }

  for (const day of AGENDA_DAYS) {
    const raw = normalized[day]
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      normalized[day] = [raw]
    }
  }

  const result = validateAvailabilitySchedule(normalized)
  return result.ok ? result.schedule : null
}
