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
  segunda: [{ inicio: '08:00', fim: '18:00' }],
  terca: [{ inicio: '08:00', fim: '18:00' }],
  quarta: [{ inicio: '08:00', fim: '18:00' }],
  quinta: [{ inicio: '08:00', fim: '18:00' }],
  sexta: [{ inicio: '08:00', fim: '18:00' }],
  sabado: null,
  domingo: null,
  timezone: 'America/Sao_Paulo',
  duracaoSlotMinutos: 30,
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
  const duracaoSlotMinutos = Number(input.duracaoSlotMinutos ?? DEFAULT_AVAILABILITY_SCHEDULE.duracaoSlotMinutos)
  if (!Number.isInteger(duracaoSlotMinutos) || duracaoSlotMinutos < 5 || duracaoSlotMinutos > 480) {
    return { ok: false, error: 'duracaoSlotMinutos precisa ser um inteiro entre 5 e 480.' }
  }

  return { ok: true, schedule: { ...schedule, timezone, duracaoSlotMinutos } as AvailabilitySchedule }
}
