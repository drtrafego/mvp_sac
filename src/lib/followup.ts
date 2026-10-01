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

export function resolveAgentSlugForCompany(slug: string): string {
  const s = (slug || '').toLowerCase()
  if (s.includes('gramado')) return 'gramadoplazza'
  if (s.includes('lucas')) return 'drlucas'
  if (s.includes('autonomia') || s.includes('gastao')) return 'agente24horas'
  if (s.includes('casal')) return 'casaldotrafego'
  return slug
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
