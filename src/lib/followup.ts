export type FollowupStep =
  | { delayMinutes: number }
  | { nextDayAtHour: number }

export type FollowupWindow = { startHour: number; endHour: number }

export type FollowupSpacing = { minSeconds: number; maxSeconds: number }

export type FollowupConfig = {
  enabled: boolean
  steps: FollowupStep[]
  window?: FollowupWindow
  spacing?: FollowupSpacing
  stepsByOrigin?: { ad?: FollowupStep[] }
}

export type FollowupSentStats = {
  sent24h: number
  sent7d: number
  lastSentAt: string | null
}

export const FOLLOWUP_DEFAULT_STEPS: FollowupStep[] = [
  { delayMinutes: 30 },
  { delayMinutes: 120 },
  { delayMinutes: 240 },
  { delayMinutes: 720 },
]

export const FOLLOWUP_DEFAULT_WINDOW: FollowupWindow = {
  startHour: 8,
  endHour: 20,
}

export const FOLLOWUP_DEFAULT_SPACING: FollowupSpacing = {
  minSeconds: 50,
  maxSeconds: 170,
}

export const MAX_FOLLOWUP_STEPS = 20

// Mapeamento explicito reconstruido de duas fontes do codigo:
// src/lib/sync-agents.ts classifyAgentCompany() e src/lib/ai-reply.ts BOT_POR_SLUG.
const AGENT_SLUG_POR_COMPANY_SLUG: Record<string, string> = {
  drlucas: 'drlucas',
  autonomia: 'agente24horas',
  amanda: 'casaldotrafego',
  'gramado-plaza': 'gramadoplazza',
}

export function resolveAgentSlugForCompany(slug: string): string | null {
  const s = (slug || '').toLowerCase().trim()
  return AGENT_SLUG_POR_COMPANY_SLUG[s] ?? null
}

export function isDelayStep(s: FollowupStep): s is { delayMinutes: number } {
  return typeof (s as { delayMinutes?: unknown }).delayMinutes === 'number'
}

export function sanitizeSteps(steps: unknown): FollowupStep[] {
  if (!Array.isArray(steps)) return []
  const vistos = new Set<string>()
  const porTempo: { delayMinutes: number }[] = []
  const noDiaSeguinte: { nextDayAtHour: number }[] = []

  for (const s of steps) {
    const o = (s ?? {}) as { delayMinutes?: unknown; nextDayAtHour?: unknown }
    if (o.nextDayAtHour !== undefined && o.nextDayAtHour !== null) {
      const h = Math.round(Number(o.nextDayAtHour))
      if (!Number.isFinite(h) || h < 0 || h > 23) continue
      const chave = `d:${h}`
      if (vistos.has(chave)) continue
      vistos.add(chave)
      noDiaSeguinte.push({ nextDayAtHour: h })
      continue
    }
    const rawVal = Number(o.delayMinutes)
    if (!Number.isFinite(rawVal) || rawVal <= 0) continue
    const delayMinutes = Math.round(rawVal)
    if (delayMinutes <= 0) continue
    const chave = `m:${delayMinutes}`
    if (vistos.has(chave)) continue
    vistos.add(chave)
    porTempo.push({ delayMinutes })
  }

  porTempo.sort((a, b) => a.delayMinutes - b.delayMinutes)
  noDiaSeguinte.sort((a, b) => a.nextDayAtHour - b.nextDayAtHour)
  return [...porTempo, ...noDiaSeguinte]
}

export function validateStepsStrict(steps: unknown, fieldName = 'steps'): FollowupStep[] {
  if (!Array.isArray(steps)) {
    throw new Error(`${fieldName} precisa ser uma lista.`)
  }

  if (steps.length > MAX_FOLLOWUP_STEPS) {
    throw new Error(`${fieldName} deve ter no máximo ${MAX_FOLLOWUP_STEPS} itens.`)
  }

  return steps.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`${fieldName}[${index}] precisa ser um objeto de degrau.`)
    }

    const record = step as Record<string, unknown>
    const keys = Object.keys(record)
    const hasDelay = Object.prototype.hasOwnProperty.call(record, 'delayMinutes')
    const hasNextDay = Object.prototype.hasOwnProperty.call(record, 'nextDayAtHour')
    const unknownKey = keys.find((key) => key !== 'delayMinutes' && key !== 'nextDayAtHour')

    if (unknownKey) {
      throw new Error(`${fieldName}[${index}] contém campo desconhecido "${unknownKey}".`)
    }

    if ((hasDelay ? 1 : 0) + (hasNextDay ? 1 : 0) !== 1) {
      throw new Error(`${fieldName}[${index}] precisa ter exatamente um entre delayMinutes e nextDayAtHour.`)
    }

    if (hasDelay) {
      const value = record.delayMinutes
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${fieldName}[${index}].delayMinutes precisa ser um inteiro positivo.`)
      }
      return { delayMinutes: value }
    }

    const value = record.nextDayAtHour
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > 23) {
      throw new Error(`${fieldName}[${index}].nextDayAtHour precisa ser um inteiro de 0 a 23.`)
    }
    return { nextDayAtHour: value }
  })
}

export function sanitizeWindow(v: unknown): FollowupWindow | undefined {
  const o = (v ?? {}) as { startHour?: unknown; endHour?: unknown }
  const ini = Math.round(Number(o.startHour))
  const fim = Math.round(Number(o.endHour))
  if (!Number.isFinite(ini) || !Number.isFinite(fim)) return undefined
  if (ini < 0 || ini > 23 || fim < 1 || fim > 24 || ini >= fim) return undefined
  return { startHour: ini, endHour: fim }
}

export function sanitizeSpacing(v: unknown): FollowupSpacing | undefined {
  const o = (v ?? {}) as { minSeconds?: unknown; maxSeconds?: unknown }
  const min = Math.round(Number(o.minSeconds))
  const max = Math.round(Number(o.maxSeconds))
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined
  if (min < 5 || max > 3600 || min > max) return undefined
  return { minSeconds: min, maxSeconds: max }
}
