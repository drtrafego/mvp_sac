import {
  AGENDA_DAYS,
  type AgendaDay,
  type AvailabilitySchedule,
  type DayRange,
} from '@/lib/agenda-schedule'

type PanelResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; data?: unknown }

export type LegacyAgendaConfig = Record<string, unknown> & {
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
      signal: init.signal ?? AbortSignal.timeout(15_000),
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

export async function readHermesAgendaConfig(slug: string): Promise<PanelResult<{ config?: LegacyAgendaConfig }>> {
  return callPanel<{ config?: LegacyAgendaConfig }>(
    `/api/agenda-config?agente=${encodeURIComponent(slug)}`,
    { method: 'GET' },
  )
}

function supportedHermesConfigMatches(
  actual: LegacyAgendaConfig | undefined,
  expected: LegacyAgendaConfig,
): boolean {
  if (!actual) return false
  return actual.timezone === expected.timezone
    && actual.slot_minutes === expected.slot_minutes
    && JSON.stringify(actual.hours) === JSON.stringify(expected.hours)
    && JSON.stringify(actual.webhook) === JSON.stringify(expected.webhook)
}

function scheduleMatchesHermesConfig(config: LegacyAgendaConfig | undefined, schedule: AvailabilitySchedule): boolean {
  if (!config) return false
  return config.timezone === schedule.timezone
    && config.slot_minutes === schedule.duracaoSlotMinutos
    && JSON.stringify(config.hours) === JSON.stringify(availabilityScheduleToLegacyHours(schedule))
}

export async function restoreHermesAgendaConfig(
  slug: string,
  config: LegacyAgendaConfig,
): Promise<PanelResult<{ config?: LegacyAgendaConfig }>> {
  if (!shouldSyncHermesAgenda(slug)) return { ok: true, status: 200, data: {} }
  const written = await callPanel<{ config?: LegacyAgendaConfig }>('/api/agenda-config', {
    method: 'POST',
    body: JSON.stringify({ agente: slug, config }),
  })
  if (!written.ok) return written
  const confirmed = await readHermesAgendaConfig(slug)
  if (!confirmed.ok) return confirmed
  if (!supportedHermesConfigMatches(confirmed.data.config, config)) {
    return {
      ok: false,
      status: confirmed.status,
      error: 'Hermes respondeu ao rollback, mas a releitura não confirmou a configuração anterior.',
      data: confirmed.data,
    }
  }
  return confirmed
}

export async function syncHermesAgendaSchedule(
  slug: string,
  schedule: AvailabilitySchedule,
): Promise<PanelResult<{ config?: LegacyAgendaConfig; previousConfig?: LegacyAgendaConfig }>> {
  if (!shouldSyncHermesAgenda(slug)) return { ok: true, status: 200, data: {} }

  const current = await readHermesAgendaConfig(slug)
  if (!current.ok) return current

  const previousConfig = current.data.config

  const config: LegacyAgendaConfig = {
    ...(previousConfig || {}),
    timezone: schedule.timezone,
    slot_minutes: schedule.duracaoSlotMinutos,
    hours: availabilityScheduleToLegacyHours(schedule),
  }

  const written = await callPanel<{ config?: LegacyAgendaConfig }>('/api/agenda-config', {
    method: 'POST',
    body: JSON.stringify({ agente: slug, config }),
  })
  if (!written.ok) return written

  // O POST do painel antigo pode responder 200 mesmo depois de sanitizar ou
  // descartar campos. A confirmação real é reler o arquivo consumido pelo bot.
  const confirmed = await readHermesAgendaConfig(slug)
  if (confirmed.ok && scheduleMatchesHermesConfig(confirmed.data.config, schedule)) {
    return {
      ok: true,
      status: confirmed.status,
      data: { config: confirmed.data.config, previousConfig },
    }
  }

  let rollbackError = ''
  if (previousConfig) {
    const rollback = await restoreHermesAgendaConfig(slug, previousConfig)
    if (!rollback.ok) rollbackError = ` Rollback também falhou: ${rollback.error}`
  }

  return {
    ok: false,
    status: confirmed.status,
    error: confirmed.ok
      ? `Hermes respondeu ao POST, mas a releitura não confirmou a grade.${rollbackError}`
      : `Hermes respondeu ao POST, mas a releitura falhou: ${confirmed.error}.${rollbackError}`,
    data: confirmed.data,
  }
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
