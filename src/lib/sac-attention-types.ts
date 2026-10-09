/** Browser-safe contract for the daily SAC work queue. */
export const ATTENTION_VIEWS = ['all', 'human', 'unassigned', 'overdue', 'today', 'mine'] as const
export type AttentionView = typeof ATTENTION_VIEWS[number]
export interface AttentionQuery { view: AttentionView; page: number; pageSize: number }
export interface AttentionItem {
  leadId: number
  name: string | null
  phone: string
  channel: string | null
  requestSummary: string | null
  nextAction: string | null
  dueAt: string | null
  humanOwnerMemberId: number | null
  humanOwnerName: string | null
  sacCaseState: string | null
  reasons: string[]
  overdue: boolean
}
export type AttentionCounts = Record<AttentionView, number>
export interface AttentionResponse {
  items: AttentionItem[]
  counts: AttentionCounts
  page: number
  pageSize: number
  total: number
  hasMore: boolean
  currentMemberId: number | null
  now: string
}
