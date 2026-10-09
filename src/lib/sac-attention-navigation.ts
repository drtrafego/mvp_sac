import { followupDayKey } from './sac-followup-date'
import { ATTENTION_VIEWS, type AttentionView } from './sac-attention-types'

export type ConversationBaseHref = '/inbox' | '/instagram'
export type ConversationReturnHref = ConversationBaseHref | '/atender-agora' | `/atender-agora?view=${AttentionView}&page=${number}`

function queueReturnState(view: string | string[] | undefined, page: string | string[] | undefined) {
  const safeView = typeof view === 'string' && ATTENTION_VIEWS.includes(view as AttentionView) ? view as AttentionView : 'all'
  const parsedPage = typeof page === 'string' && /^[1-9]\d*$/.test(page) ? Number(page) : 1
  const safePage = Number.isSafeInteger(parsedPage) && parsedPage <= 10_000 ? parsedPage : 1
  return { view: safeView, page: safePage }
}

export function isAttentionReturnHref(href: ConversationReturnHref) {
  return href === '/atender-agora' || href.startsWith('/atender-agora?')
}

/** Only allowlisted query values can affect the conversation's entry state. */
export function attentionConversationNavigation(
  searchParams: Record<string, string | string[] | undefined>,
  baseHref: ConversationBaseHref,
) {
  const fromAttention = searchParams.from === 'attention'
  const queueState = queueReturnState(searchParams.attentionView, searchParams.attentionPage)
  const attentionHref: ConversationReturnHref = searchParams.attentionView === undefined && searchParams.attentionPage === undefined
    ? '/atender-agora'
    : `/atender-agora?view=${queueState.view}&page=${queueState.page}`
  return {
    fromAttention,
    initialContextOpen: searchParams.context === '1',
    backHref: fromAttention ? attentionHref : baseHref,
    conversationHref: baseHref,
  }
}

/** A return destination is never used as the prefix for a conversation route. */
export function attentionMessageReferenceHref(
  baseHref: ConversationBaseHref,
  leadId: number,
  messageId: number,
  backHref: ConversationReturnHref,
) {
  const query = new URLSearchParams({ aroundMessageId: String(messageId), context: '1' })
  if (isAttentionReturnHref(backHref)) {
    query.set('from', 'attention')
    if (backHref.includes('?')) {
      const returnQuery = new URLSearchParams(backHref.split('?')[1])
      const queueState = queueReturnState(returnQuery.get('view') ?? undefined, returnQuery.get('page') ?? undefined)
      query.set('attentionView', queueState.view)
      query.set('attentionPage', String(queueState.page))
    }
  }
  return `${baseHref}/${leadId}?${query.toString()}`
}

export interface PersistedSacContext {
  sacCaseState?: string | null
  nextAction?: string | null
  nextActionDueAt?: string | Date | null
  humanOwnerName?: string | null
  humanOwnerMemberId?: number | null
  humanOwnerUserId?: string | null
}

const STATE_LABELS: Record<string, string> = {
  aberto: 'Aberto', em_atendimento: 'Em atendimento', aguardando_retorno: 'Aguardando retorno',
  transbordo: 'Precisa de humano', resolvido: 'Resolvido', reaberto: 'Reaberto',
}

/** Call with the confirmed server snapshot, not the editable context draft. */
export function persistedSacContextSummary(context: PersistedSacContext, now = new Date()) {
  const state = context.sacCaseState || 'aberto'
  let dueDay: string | null = null
  try { dueDay = followupDayKey(context.nextActionDueAt) } catch { /* Do not label legacy invalid dates. */ }
  const today = followupDayKey(now)
  return {
    state,
    stateLabel: STATE_LABELS[state] || state.replaceAll('_', ' '),
    owner: context.humanOwnerName?.trim()
      || (context.humanOwnerMemberId ? `Responsável #${context.humanOwnerMemberId}` : null)
      || (context.humanOwnerUserId ? 'Atendente designado' : 'Sem responsável humano'),
    nextAction: context.nextAction?.trim() || 'Nenhuma ação registrada',
    dueDay,
    dueLabel: dueDay ? dueDay.split('-').reverse().join('/') : null,
    overdue: Boolean(dueDay && today && dueDay < today && state !== 'resolvido'),
  }
}
