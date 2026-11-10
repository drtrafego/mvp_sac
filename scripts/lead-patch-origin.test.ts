// PATCH /api/leads/:id com trackingSource: lista editável, valor atual preservado, escopo por empresa.
// Uso: node --experimental-test-module-mocks --import tsx --test scripts/lead-patch-origin.test.ts
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import { createSacTestDatabase } from './sac-test-pglite'
import * as schema from '../src/lib/db/schema'

async function main() {
  const database = await createSacTestDatabase([schema.companies, schema.settings, schema.recoveryLeads])
  const dbProxy = new Proxy({}, { get: (_t, key) => { const v = Reflect.get(database.db, key); return typeof v === 'function' ? v.bind(database.db) : v } })
  mock.module('@/lib/db', { namedExports: { db: dbProxy } })
  mock.module('@/lib/auth', { namedExports: { requireCompany: async () => ({ id: 1 }) } })
  const route = await import('../src/app/api/leads/[leadId]/route')
  await database.db.insert(schema.companies).values([{ id: 1, name: 'A', slug: 'a' }, { id: 2, name: 'B', slug: 'b' }])
  await database.db.insert(schema.recoveryLeads).values([
    { id: 10, companyId: 1, phone: 'ig_1', name: 'Pessoa', status: 'in_conversation', channel: 'instagram', eventType: 'instagram_direct', trackingSource: 'meta_messaging_unattributed' },
    { id: 20, companyId: 2, phone: '5511', name: 'Outra empresa', status: 'in_conversation', channel: 'whatsapp', eventType: 'atendimento', trackingSource: 'whatsapp_direto' },
  ])
  const patch = (id: number, body: Record<string, unknown>) =>
    route.PATCH(new NextRequest(`https://sac.test/api/leads/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ leadId: String(id) }) })
  const origin = async (id: number) => (await database.db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, id)))[0].trackingSource

  test('troca para origem da lista editável', async () => {
    assert.equal((await patch(10, { trackingSource: 'indicacao' })).status, 200)
    assert.equal(await origin(10), 'indicacao')
  })
  test('origem inventada ou texto malicioso é recusado e não grava', async () => {
    for (const bad of ['origem_totalmente_inventada', 'DROP TABLE leads']) {
      assert.equal((await patch(10, { trackingSource: bad })).status, 400)
    }
    assert.equal(await origin(10), 'indicacao')
  })
  test('reenviar o valor atual automático (formulário de edição) continua aceito', async () => {
    await database.pg.exec(`update recovery_leads set tracking_source='meta_messaging_unattributed' where id=10`)
    assert.equal((await patch(10, { trackingSource: 'meta_messaging_unattributed', notes: 'x' })).status, 200)
    assert.equal(await origin(10), 'meta_messaging_unattributed')
  })
  test('lead de outra empresa não é alterado', async () => {
    assert.equal((await patch(20, { trackingSource: 'indicacao' })).status, 404)
    assert.equal(await origin(20), 'whatsapp_direto')
  })
}
main()
