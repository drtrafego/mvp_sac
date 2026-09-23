export interface EmailEngagement {
  funnelStatus: string
  lastEventType: string
  everOpened: boolean
  everBounced: boolean
  everUnsubscribed: boolean
  lastEventAt: string
  lastStep: number | null
  totalEventsCount: number
  syncedAt: string
}

export function getEmailEngagement(
  miningTags: Record<string, unknown> | null | undefined
): EmailEngagement | null {
  const value = miningTags?.emailEngagement
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const candidate = value as Record<string, unknown>
  if (typeof candidate.funnelStatus !== 'string' || !candidate.funnelStatus.trim()) return null

  return candidate as unknown as EmailEngagement
}
