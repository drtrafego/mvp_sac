/** Acceptance is a provider acknowledgement, never proof of delivery or read. */
export type SendMetricState = 'accepted' | 'failed' | 'pending' | 'uncertain' | 'unknown'
export interface ChannelSendAggregate { channel: string | null; sendState: string | null; hasExternalId: boolean; total: number }
export interface ChannelSendMetrics { total: number; accepted: number; failed: number; pending: number; uncertain: number; unknown: number }

export function classifySendMetric(state: string | null, hasExternalId: boolean): SendMetricState {
  if (state === 'accepted') return hasExternalId ? 'accepted' : 'unknown'
  if (state === 'pending' || state === 'failed' || state === 'uncertain') return state
  return 'unknown'
}

export function aggregateChannelSendMetrics(rows: readonly ChannelSendAggregate[]): Map<string, ChannelSendMetrics> {
  const result = new Map<string, ChannelSendMetrics>()
  for (const row of rows) {
    const key = row.channel || 'unknown'
    const metric = result.get(key) || { total: 0, accepted: 0, failed: 0, pending: 0, uncertain: 0, unknown: 0 }
    const count = Number.isFinite(row.total) ? Math.max(0, row.total) : 0
    metric.total += count
    metric[classifySendMetric(row.sendState, row.hasExternalId)] += count
    result.set(key, metric)
  }
  return result
}
