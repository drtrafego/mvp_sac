import {
  AGENDA_DAYS,
  type AgendaDay,
  type AvailabilitySchedule,
  type DayRange,
} from '@/lib/agenda-schedule'

type PanelResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; data?: unknown }

type LegacyAgendaConfig = Record<string, unknown> & {
  timezone?: string
  slot_minutes?: number
  hours?: Record<string, [string, string][]>
  webhook?: unknown
}

const DEFAULT_PANEL_URL = 'https://hermes.casaldotrafego.com/agente'
const DRLUCAS_SLUG = 'drlucas'

const DAY_TO_LEGACY: Record<AgendaDay, string> = {
  domingo: '0',
  segunda: '1',
  terca: '2',
  quarta: '3',
  quinta: '4',
  sexta: '5',
  sabado: '6',
}

function panelBaseUrl(): string {
  return (process.env.HERMES_PANEL_URL || DEFAULT_PANEL_URL).replace(/\/+$/, '')
}

function panelToken(): string {
  return (process.env.PAINEL_API_TOKEN || '').trim()
}

async function callPanel<T = unknown>(path: string, init: RequestInit): Promise<PanelResult<T>> {
  const token = panelToken()
  if (!token) {
    return {
      ok: false,
      status: 0,
      error: 'PAINEL_API_TOKEN não configurado no servidor.',
    }
  }

  try {
    const res = await fetch(`${panelBaseUrl()}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.headers || {}),
      },
      cache: 'no-store',
    })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      data = null
    }
    if (!res.ok) {
      const message =
        data && typeof data === 'object' && 'erro' in data
          ? String((data as { erro: unknown }).erro)
          : data && typeof data === 'object' && 'error' in data
            ? String((data as { error: unknown }).error)
            : `Erro ${res.status} no painel Hermes.`
      return { ok: false, status: res.status, error: message, data }
    }
    return { ok: true, status: res.status, data: data as T }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : 'Falha de rede ao contatar o painel Hermes.',
    }
  }
}

export function shouldSyncHermesAgenda(slug: string): boolean {
  return slug === DRLUCAS_SLUG
}

export function shouldSyncHermesAgendaBlockRemoval(slug: string, source: string | null | undefined): boolean {
  if (!shouldSyncHermesAgenda(slug)) return false
  const normalized = String(source || 'manual')
  return normalized === 'manual' || normalized.includes('bot_bloqueios')
}

export function availabilityScheduleToLegacyHours(schedule: AvailabilitySchedule): Record<string, [string, string][]> {
  const hours: Record<string, [string, string][]> = {
    '0': [],
    '1': [],
    '2': [],
    '3': [],
    '4': [],
    '5': [],
    '6': [],
  }

  for (const day of AGENDA_DAYS) {
    const ranges = schedule[day] ?? []
    hours[DAY_TO_LEGACY[day]] = ranges.map((range: DayRange) => [range.inicio, range.fim])
  }

  return hours
}

async function readHermesAgendaConfig(slug: string): Promise<PanelResult<{ config?: LegacyAgendaConfig }>> {
  return callPanel<{ config?: LegacyAgendaConfig }>(
    `/api/agenda-config?agente=${encodeURIComponent(slug)}`,
    { method: 'GET' },
  )
}

export async function syncHermesAgendaSchedule(
  slug: string,
  schedule: AvailabilitySchedule,
): Promise<PanelResult<{ config?: LegacyAgendaConfig }>> {
  if (!shouldSyncHermesAgenda(slug)) return { ok: true, status: 200, data: {} }

  const current = await readHermesAgendaConfig(slug)
  if (!current.ok) return current

  const config: LegacyAgendaConfig = {
    ...(current.data.config || {}),
    timezone: schedule.timezone,
    slot_minutes: schedule.duracaoSlotMinutos,
    hours: availabilityScheduleToLegacyHours(schedule),
  }

  return callPanel<{ config?: LegacyAgendaConfig }>('/api/agenda-config', {
    method: 'POST',
    body: JSON.stringify({ agente: slug, config }),
  })
}

export async function syncHermesAgendaBlockDate(
  slug: string,
  date: string,
  reason: string,
  blocked: boolean,
): Promise<PanelResult> {
  if (!shouldSyncHermesAgenda(slug)) return { ok: true, status: 200, data: {} }

  return callPanel(blocked ? '/api/agenda-bloquear' : '/api/agenda-desbloquear', {
    method: 'POST',
    body: JSON.stringify({
      agente: slug,
      data: date,
      ...(blocked ? { motivo: reason } : {}),
    }),
  })
}
