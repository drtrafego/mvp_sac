// Independent review: execute the work-queue SQL on disposable PostgreSQL WASM.
// No production database, provider or authenticated browser is used.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSacTestDatabase } from './sac-test-pglite'
import * as schema from '../src/lib/db/schema'
import { loadSacAttention, parseAttentionQuery } from '../src/lib/sac-attention'
import { followupDayToIso } from '../src/lib/sac-followup-date'

async function fixture() {
  const f = await createSacTestDatabase([schema.companyMembers, schema.recoveryLeads, schema.sacPendingItems])
  await f.db.insert(schema.companyMembers).values([
    { id: 10, companyId: 1, stackAuthUserId: 'operator', name: 'Operator A', email: 'a@example.test', role: 'membro', status: 'ativo' },
    { id: 20, companyId: 2, stackAuthUserId: 'operator', name: 'PRIVATE foreign operator', email: 'foreign@example.test', role: 'membro', status: 'ativo' },
    { id: 21, companyId: 2, stackAuthUserId: 'foreign-only', name: 'PRIVATE other operator', email: 'other@example.test', role: 'membro', status: 'ativo' },
    { id: 30, companyId: 1, stackAuthUserId: 'pending-user', name: 'Pending account', email: 'pending@example.test', role: 'admin', status: 'pending' },
  ])
  const load = (view: 'all' | 'overdue' | 'today' | 'mine' | 'unassigned' | 'human' = 'all', now = '2026-10-09T15:00:00-03:00', userId = 'operator', page = 1, pageSize = 25) =>
    loadSacAttention({ companyId: 1, userId, view, now: new Date(now), page, pageSize }, f.db)
  return { ...f, load }
}

test('review: multiple problems remain one contact and counts are independent of the page', async () => {
  const f = await fixture()
  try {
    await f.db.insert(schema.recoveryLeads).values([
      { id: 100, companyId: 1, phone: '5511000000', name: 'Multiple problems', sacCaseState: 'transbordo', humanOwnerMemberId: 10, nextAction: 'Send document', nextActionDueAt: new Date(followupDayToIso('2026-10-07')!), followUpDate: new Date(followupDayToIso('2026-10-08')!) },
      { id: 102, companyId: 1, phone: '5511000002', name: 'Converted customer needing support', status: 'converted', sacCaseState: 'aberto', humanOwnerMemberId: 10, followUpDate: new Date(followupDayToIso('2026-10-08')!) },
    ].map(row => ({ ...row, eventType: 'atendimento' })))
    await f.db.insert(schema.sacPendingItems).values([
      { companyId: 1, leadId: 100, ruleType: 'proxima_acao_vencida', sourceKey: 'episode:1', reason: 'Document promised', state: 'pendente' },
      { companyId: 1, leadId: 100, ruleType: 'retorno_vencido', sourceKey: 'episode:1', reason: 'Return promised', state: 'em_atendimento' },
    ])
    const first = await f.load('all', undefined, undefined, 1, 1)
    const second = await f.load('all', undefined, undefined, 2, 1)
    assert.equal(first.total, 2)
    assert.equal(first.counts.all, 2)
    assert.equal(first.counts.overdue, 2)
    assert.equal(first.counts.mine, 2)
    assert.equal(first.hasMore, true)
    assert.equal(second.hasMore, false)
    assert.deepEqual([...first.items, ...second.items].map(item => item.leadId), [100, 102])
    assert.equal(first.items[0].reasons.includes('Document promised'), true)
    assert.equal(first.items[0].reasons.includes('Return promised'), true)
  } finally { await f.close() }
})

test('review: tenant and current-member identity remain isolated; resolved, pause-only and ordinary unowned contacts stay out', async () => {
  const f = await fixture()
  try {
    const past = new Date(followupDayToIso('2026-10-08')!)
    await f.db.insert(schema.recoveryLeads).values([
      { id: 100, companyId: 1, phone: 'same-phone', name: 'Valid A', sacCaseState: 'aberto', humanOwnerMemberId: 10, followUpDate: past },
      { id: 101, companyId: 1, phone: 'resolved', sacCaseState: 'resolvido', nextActionDueAt: past, nextAction: 'Old promise' },
      { id: 103, companyId: 1, phone: 'paused', sacCaseState: 'aberto', botPaused: true, botPausedAt: past },
      { id: 104, companyId: 1, phone: 'ordinary', sacCaseState: 'aberto', humanOwnerMemberId: null },
      { id: 200, companyId: 2, phone: 'same-phone', name: 'PRIVATE customer B', sacCaseState: 'transbordo', humanOwnerMemberId: 20, nextAction: 'PRIVATE request B', followUpDate: past },
    ].map(row => ({ ...row, eventType: 'atendimento' })))
    await f.db.insert(schema.sacPendingItems).values([
      { companyId: 1, leadId: 101, ruleType: 'retorno_vencido', sourceKey: 'episode:1', reason: 'Obsolete resolved alert', state: 'pendente' },
      // An inconsistent historical relation must never inject another tenant's text.
      { companyId: 2, leadId: 100, ruleType: 'retorno_vencido', sourceKey: 'episode:1', reason: 'PRIVATE foreign pending text', state: 'pendente' },
    ])
    const actual = await f.load()
    assert.equal(actual.currentMemberId, 10)
    assert.deepEqual(actual.items.map(item => item.leadId), [100])
    assert.equal(JSON.stringify(actual).includes('PRIVATE'), false)
    assert.equal((await f.load('mine', undefined, 'foreign-only')).total, 0)
    assert.equal((await f.load('mine', undefined, 'pending-user')).currentMemberId, null)
    assert.equal((await f.load('unassigned')).total, 0)
    const parsed = parseAttentionQuery(new URLSearchParams('view=mine&companyId=2&memberId=20&userId=foreign-only'))
    assert.deepEqual(parsed, { view: 'mine', page: 1, pageSize: 25 })
  } finally { await f.close() }
})

test('review: due-day remains current through Sao Paulo midnight; handoff pause time is not a deadline', async () => {
  const f = await fixture()
  try {
    await f.db.insert(schema.recoveryLeads).values([
      { id: 100, companyId: 1, phone: 'deadline', sacCaseState: 'aberto', nextAction: 'Promised today', nextActionDueAt: new Date(followupDayToIso('2026-10-09')!) },
      { id: 101, companyId: 1, phone: 'handoff', sacCaseState: 'transbordo', botPausedAt: new Date('2026-10-01T00:00:00Z') },
    ].map(row => ({ ...row, eventType: 'atendimento' })))
    const today = await f.load('today', '2026-10-10T02:59:59.999Z')
    assert.deepEqual(today.items.map(item => item.leadId), [100])
    assert.equal(today.items[0].overdue, false)
    assert.equal(today.items[0].dueAt, '2026-10-09T15:00:00.000Z')
    const tomorrow = await f.load('overdue', '2026-10-10T03:00:00.000Z')
    assert.deepEqual(tomorrow.items.map(item => item.leadId), [100])
    const handoff = (await f.load('human', '2026-10-10T03:00:00.000Z')).items[0]
    assert.equal(handoff.leadId, 101)
    assert.equal(handoff.dueAt, null)
    assert.equal(handoff.overdue, false)
  } finally { await f.close() }
})
