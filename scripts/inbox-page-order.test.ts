import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { recoveryLeads, whatsappMessages } from '../src/lib/db/schema'
import { mergeInboxPage } from '../src/lib/inbox-client'
import type { ConversationSummary } from '../src/lib/inbox-conversations'
import { createSacTestDatabase } from './sac-test-pglite'

function card(id: number, fraction: string): ConversationSummary {
  return {
    id, phone: '', name: null, status: null, productName: null,
    eventType: 'test', unread: 0, lastDirection: null, lastMessage: null,
    lastMessageAt: `2026-01-01T00:00:00.${fraction}Z`,
  }
}

const ids = (rows: ConversationSummary[]) => rows.map(row => row.id)

test('reposição e paginação preservam a ordem SQL dentro do mesmo milissegundo', () => {
  const head = [card(2, '123900'), card(4, '123500')]
  assert.deepEqual(ids(mergeInboxPage([], head, 'replace')), [2, 4])
  const next = [head[1], card(7, '123400'), card(9, '123100')]
  assert.deepEqual(ids(mergeInboxPage(head, next, 'append')), [2, 4, 7, 9])
})

test('polling promove o cartão atualizado, insere o novo e conserva o restante sem duplicar', () => {
  const current = [card(2, '123900'), card(4, '123500'), card(9, '123100')]
  const updated = { ...card(9, '123990'), lastMessage: 'nova' }
  const incoming = [updated, card(1, '123980'), current[0]]
  assert.deepEqual(mergeInboxPage(current, incoming, 'poll'), [...incoming, current[1]])
})

test('cursor do loader real conserva microssegundos e desempata timestamps idênticos por id', async () => {
  const fixture = await createSacTestDatabase([recoveryLeads, whatsappMessages])
  try {
    mock.module('@/lib/db', { namedExports: { db: fixture.db } })
    const { loadInboxPage, decodeInboxCursor } = await import('../src/lib/inbox-conversations')
    await fixture.pg.exec(`
      INSERT INTO recovery_leads (id, company_id, phone, event_type)
      SELECT n, 1, n::text, 'test' FROM generate_series(1, 4) AS n;
      INSERT INTO whatsapp_messages (lead_id, company_id, direction, created_at)
      VALUES (1, 1, 'inbound', '2026-01-01 00:00:00.123900'),
             (2, 1, 'inbound', '2026-01-01 00:00:00.123500'),
             (3, 1, 'inbound', '2026-01-01 00:00:00.123500'),
             (4, 1, 'inbound', '2026-01-01 00:00:00.123100');
    `)
    const first = await loadInboxPage({ companyId: 1, limit: 2 })
    assert.deepEqual(ids(first.conversations), [1, 3])
    assert.equal(first.conversations[1].lastMessageAt, '2026-01-01T00:00:00.123500Z')
    assert.ok(first.nextCursor)
    assert.equal(decodeInboxCursor(first.nextCursor)?.at, first.conversations[1].lastMessageAt)
    const second = await loadInboxPage({ companyId: 1, limit: 2, cursor: first.nextCursor })
    assert.deepEqual(ids(second.conversations), [2, 4])
    assert.equal(second.nextCursor, null)
    const loaded = mergeInboxPage(first.conversations, second.conversations, 'append')
    assert.deepEqual(ids(loaded), [1, 3, 2, 4])

    await fixture.pg.exec(`
      INSERT INTO whatsapp_messages (lead_id, company_id, direction, created_at)
      VALUES (2, 1, 'inbound', '2026-01-01 00:00:00.123999');
    `)
    const poll = await loadInboxPage({ companyId: 1, limit: 2 })
    assert.deepEqual(ids(mergeInboxPage(loaded, poll.conversations, 'poll')), [2, 1, 3, 4])
    const legacyCursor = Buffer.from(JSON.stringify({ at: '2026-01-01 00:00:00.123500', id: 3 })).toString('base64url')
    const afterLegacy = await loadInboxPage({ companyId: 1, limit: 2, cursor: legacyCursor })
    assert.deepEqual(ids(afterLegacy.conversations), [4])
  } finally {
    await fixture.close()
  }
})

