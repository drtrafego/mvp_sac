import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attentionConversationNavigation, attentionMessageReferenceHref, persistedSacContextSummary } from '../src/lib/sac-attention-navigation'

test('attention entry opens the existing Context tab and returns to the daily queue', () => {
  assert.deepEqual(attentionConversationNavigation({ context: '1', from: 'attention' }, '/inbox'), {
    fromAttention: true, initialContextOpen: true, backHref: '/atender-agora', conversationHref: '/inbox',
  })
})

test('normal Instagram navigation keeps its own return destination', () => {
  assert.deepEqual(attentionConversationNavigation({}, '/instagram'), {
    fromAttention: false, initialContextOpen: false, backHref: '/instagram', conversationHref: '/instagram',
  })
})

test('external and ambiguous query values cannot change the return href or open the panel', () => {
  const external = attentionConversationNavigation({ from: 'https://example.com', context: 'true' }, '/inbox')
  assert.equal(external.backHref, '/inbox')
  assert.equal(external.initialContextOpen, false)
  const ambiguous = attentionConversationNavigation({ from: ['attention', 'https://example.com'], context: ['1', '0'] }, '/instagram')
  assert.equal(ambiguous.backHref, '/instagram')
  assert.equal(ambiguous.initialContextOpen, false)
})

test('message references use the conversation route even when returning to Atender agora', () => {
  assert.equal(attentionMessageReferenceHref('/inbox', 12, 99, '/atender-agora'), '/inbox/12?aroundMessageId=99&context=1&from=attention')
  assert.equal(attentionMessageReferenceHref('/instagram', 12, 99, '/instagram'), '/instagram/12?aroundMessageId=99&context=1')
})

test('a daily queue filter and page survive opening the conversation and its reference message', () => {
  const navigation = attentionConversationNavigation({ context: '1', from: 'attention', attentionView: 'overdue', attentionPage: '3' }, '/inbox')
  assert.equal(navigation.backHref, '/atender-agora?view=overdue&page=3')
  assert.equal(attentionMessageReferenceHref('/inbox', 12, 99, navigation.backHref), '/inbox/12?aroundMessageId=99&context=1&from=attention&attentionView=overdue&attentionPage=3')
})

test('invalid filters and page values fall back to an allowlisted internal queue', () => {
  for (const value of ['0', '-2', '1e3', '10001', 'https://example.com', '999999999999999999999']) {
    assert.equal(attentionConversationNavigation({ from: 'attention', attentionView: 'https://example.com', attentionPage: value }, '/inbox').backHref, '/atender-agora?view=all&page=1')
  }
  assert.equal(attentionConversationNavigation({ from: 'attention', attentionView: ['mine'], attentionPage: ['2'] }, '/inbox').backHref, '/atender-agora?view=all&page=1')
})

test('the deadline remains on time throughout its Sao Paulo calendar day', () => {
  const context = { nextActionDueAt: '2026-10-09T15:00:00.000Z', sacCaseState: 'em_atendimento' }
  const sameDay = persistedSacContextSummary(context, new Date('2026-10-10T02:59:59.999Z'))
  assert.equal(sameDay.dueDay, '2026-10-09')
  assert.equal(sameDay.dueLabel, '09/10/2026')
  assert.equal(sameDay.overdue, false)
  assert.equal(persistedSacContextSummary(context, new Date('2026-10-10T03:00:00.000Z')).overdue, true)
})

test('date-only deadlines and timestamps use the same business-day convention', () => {
  const now = new Date('2026-10-10T04:00:00Z')
  const dateOnly = persistedSacContextSummary({ nextActionDueAt: '2026-10-09' }, now)
  const lateUtc = persistedSacContextSummary({ nextActionDueAt: '2026-10-10T01:30:00Z' }, now)
  assert.equal(dateOnly.dueDay, lateUtc.dueDay)
  assert.equal(dateOnly.overdue, true)
  assert.equal(lateUtc.overdue, true)
})

test('a resolved case does not show an overdue action', () => {
  const summary = persistedSacContextSummary({ nextActionDueAt: '2026-10-01', sacCaseState: 'resolvido' }, new Date('2026-10-09T15:00:00Z'))
  assert.equal(summary.stateLabel, 'Resolvido')
  assert.equal(summary.overdue, false)
})

test('missing context is clearly labelled without inventing a human owner or action', () => {
  const summary = persistedSacContextSummary({}, new Date('2026-10-09T15:00:00Z'))
  assert.equal(summary.stateLabel, 'Aberto')
  assert.equal(summary.owner, 'Sem responsável humano')
  assert.equal(summary.nextAction, 'Nenhuma ação registrada')
  assert.equal(summary.dueLabel, null)
  assert.equal(summary.overdue, false)
})

test('invalid legacy deadlines do not crash the summary or create a false overdue badge', () => {
  const summary = persistedSacContextSummary({ nextActionDueAt: 'invalid-date' }, new Date('2026-10-09T15:00:00Z'))
  assert.equal(summary.dueLabel, null)
  assert.equal(summary.overdue, false)
})

test('the summary displays a resolved owner name and only falls back to assignment identifiers', () => {
  assert.equal(persistedSacContextSummary({ humanOwnerName: ' Luana ', humanOwnerMemberId: 12 }).owner, 'Luana')
  assert.equal(persistedSacContextSummary({ humanOwnerName: ' ', humanOwnerMemberId: 12 }).owner, 'Responsável #12')
  assert.equal(persistedSacContextSummary({ humanOwnerUserId: 'stack-user-12' }).owner, 'Atendente designado')
  assert.equal(persistedSacContextSummary({ nextAction: '  Enviar orçamento  ' }).nextAction, 'Enviar orçamento')
})
