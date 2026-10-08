import { inferPipelineStage } from '../../lib/pipeline-stage'
import { followupDayKey, followupDayToIso } from '../../lib/sac-followup-date'

export interface SacContextDraft {
  requestSummary: string
  commitment: string
  nextAction: string
  nextActionDueAt: string
  pipelineStage: string
  followUpDate: string
  followUpNote: string
  sacCaseState: string
}

export type SacContextSource = Partial<Record<keyof SacContextDraft, string | null>> & {
  status?: string | null
  eventType?: string | null
  priority?: number | null
}

export function contextFromLead(lead: SacContextSource): SacContextDraft {
  return {
    requestSummary: lead.requestSummary ?? '',
    commitment: lead.commitment ?? '',
    nextAction: lead.nextAction ?? '',
    nextActionDueAt: lead.nextActionDueAt ? followupDayKey(lead.nextActionDueAt) ?? '' : '',
    pipelineStage: inferPipelineStage(lead),
    followUpDate: lead.followUpDate ? followupDayKey(lead.followUpDate) ?? '' : '',
    followUpNote: lead.followUpNote ?? '',
    sacCaseState: lead.sacCaseState ?? 'aberto',
  }
}

export function mergeContextDraft(
  draft: SacContextDraft,
  incoming: SacContextDraft,
  dirtyFields: ReadonlySet<keyof SacContextDraft>,
): SacContextDraft {
  const merged = { ...incoming }
  for (const field of dirtyFields) merged[field] = draft[field]
  return merged
}

export function buildContextPatch(
  draft: SacContextDraft,
  fields: ReadonlySet<keyof SacContextDraft>,
  expectedContextVersion: number,
): Record<string, string | number | null> {
  const patch: Record<string, string | number | null> = { expectedContextVersion }
  for (const field of fields) {
    const value = draft[field]
    patch[field] = field === 'nextActionDueAt' || field === 'followUpDate'
      ? followupDayToIso(value)
      : value.trim() || null
  }
  return patch
}

export function unresolvedReplyVariables(value: string): string[] {
  return [...new Set(Array.from(value.matchAll(/\{([a-zA-Z0-9_]+)\}/g), match => match[1]))]
}

export function fillReplyTemplate(value: string, variables: Record<string, string | null | undefined>): string {
  return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (token, key: string) => {
    const actualKey = Object.keys(variables).find(name => name.toLowerCase() === key.toLowerCase())
    const replacement = actualKey ? variables[actualKey]?.trim() : undefined
    return replacement || token
  })
}

export interface ComposerIntent {
  clientRequestId: string
  content: string
  state: 'pending' | 'uncertain' | 'failed'
}

export function canStartComposerIntent(intent: ComposerIntent | null, content: string): boolean {
  return !intent || intent.content === content || intent.state === 'failed'
}

export function draftAfterAccepted(currentDraft: string, submittedContent: string): string {
  return currentDraft.trim() === submittedContent ? '' : currentDraft
}

export function upsertInboxMessages<T extends { id: number; createdAt: string | null }>(previous: T[], incoming: T[]): T[] {
  const merged = new Map(previous.map(message => [message.id, message]))
  for (const message of incoming) merged.set(message.id, message)
  return [...merged.values()].sort((a, b) => (
    new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime() || a.id - b.id
  ))
}
