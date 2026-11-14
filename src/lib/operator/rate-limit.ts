type Entry = { count: number; resetAt: number }
const requests = new Map<string, Entry>()

export function operatorRateLimit(key: string, limit = 20, windowMs = 60_000): boolean {
  const now = Date.now(); const prior = requests.get(key)
  if (!prior || prior.resetAt <= now) { requests.set(key, { count: 1, resetAt: now + windowMs }); return true }
  if (prior.count >= limit) return false
  prior.count += 1; return true
}
