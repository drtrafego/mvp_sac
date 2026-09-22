export type InboxSourceFields = {
  trackingSource?: string | null
  platform?: string | null
}

const DIRECT_ORGANIC_ALIASES = new Set([
  'direto',
  'direto / organico',
  'direto / orgânico',
  'organico',
  'orgânico',
])

export function normalizeInboxSourceFilter(value: string | null | undefined): string {
  return (value || '').trim()
}

export function isDirectOrganicSourceFilter(value: string | null | undefined): boolean {
  const normalized = normalizeInboxSourceFilter(value).toLowerCase()
  return DIRECT_ORGANIC_ALIASES.has(normalized)
}

export function matchesInboxSourceFilter(fields: InboxSourceFields, sourceFilter: string | null | undefined): boolean {
  const source = normalizeInboxSourceFilter(sourceFilter)
  if (!source) return true

  const trackingSource = (fields.trackingSource || '').trim()
  const platform = (fields.platform || '').trim()

  if (isDirectOrganicSourceFilter(source)) {
    return !trackingSource && !platform
  }

  const term = source.toLowerCase()
  return trackingSource.toLowerCase().includes(term) || platform.toLowerCase().includes(term)
}
