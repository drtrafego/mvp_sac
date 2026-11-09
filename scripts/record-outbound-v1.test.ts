// Registro de outbound externo pelo endpoint v1: usa PGlite descartável,
// autenticação real por chave de agente e nunca abre conexão com fornecedor.
// Uso: node --experimental-test-module-mocks --import tsx --test scripts/record-outbound-v1.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { createSacTestDatabase } from './sac-test-pglite'
import * as schema from '../src/lib/db/schema'

const tables = [schema.companies, schema.settings, schema.recoveryLeads, schema.whatsappMessages, schema.agentActivityLogs]
function request(idOrSlug: string, body: Record<string, unknown>, apiKey?: string) {
  return new NextRequest(`https://sac.example.test/api/v1/companies/${idOrSlug}/conversations/lead:10/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    body: JSON.stringify(body),
  })
}

const recordBody = {
  recordOnly: true,
  externalId: 'wamid.HBgMNTU2NTk5MTMzMzI1FQIAERgSQTQwODJBQjE5MjFGMjNEQTg2AA==',
  sendState: 'accepted',
  createdAt: '2026-11-08T14:30:00.000Z',
  messageType: 'template',
  content: 'Material Itero enviado.',
  clientRequestId: 'record-only:498:wamid.HBgMNTU2NTk5MTMzMzI1FQIAERgSQTQwODJBQjE5MjFGMjNEQTg2AA==',
}

async function main() {
  const database = await createSacTestDatabase(tables)
  const dbProxy = new Proxy({}, { get: (_target, key) => {
    const value = Reflect.get(database.db, key)
    return typeof value === 'function' ? value.bind(database.db) : value
  } })
  let transportCalls = 0
  mock.module('@/lib/db', { namedExports: { db: dbProxy } })
  mock.module('@/lib/auth', { namedExports: { getCurrentUser: async () => null, getCurrentCompany: async () => null } })
  mock.module('@/lib/outbound-send', { namedExports: {
    sendOutboundForLead: async () => { transportCalls += 1; throw new Error('transport must not run for recordOnly') },
  } })
  const route = await import('../src/app/api/v1/companies/[idOrSlug]/conversations/[contact]/messages/route')
  const params = (idOrSlug = 'empresa-a', contact = 'lead:10') => ({ params: Promise.resolve({ idOrSlug, contact }) })

  async function reset() {
    transportCalls = 0
    await database.pg.exec('delete from "whatsapp_messages"; delete from "recovery_leads"; delete from "settings"; delete from "companies";')
    await database.db.insert(schema.companies).values([
    { id: 1, name: 'Empresa A', slug: 'empresa-a' },
    { id: 2, name: 'Empresa B', slug: 'empresa-b' },
  ])
    await database.db.insert(schema.settings).values([
    { companyId: 1, agentBiaApiKey: 'company-a-key' },
    { companyId: 2, agentBiaApiKey: 'company-b-key' },
  ])
    await database.db.insert(schema.recoveryLeads).values({
    id: 10, companyId: 1, phone: '+55 (11) 99999-0000', name: 'Contato A', status: 'in_conversation', channel: 'whatsapp', eventType: 'api_outbound',
    })
  }

  test('recordOnly is authenticated, idempotent, company-isolated, and never sends', async (suite) => {
  suite.after(async () => { await database.close() })

  await suite.test('requires an agent credential before any write', async () => {
    await reset()
    const response = await route.POST(request('empresa-a', recordBody), params())
    assert.equal(response.status, 401)
    const rows = await database.db.select().from(schema.whatsappMessages)
    assert.equal(rows.length, 0)
    assert.equal(transportCalls, 0)
  })

  await suite.test('stores a normalized accepted template without calling the transport and replays one row', async () => {
    await reset()
    const first = await route.POST(request('empresa-a', recordBody, 'company-a-key'), params())
    assert.equal(first.status, 201, JSON.stringify(await first.clone().json()))
    const firstJson = await first.json()
    assert.equal(firstJson.idempotentReplay, false)
    assert.equal(firstJson.sentMessage.phone, '5511999990000')
    assert.equal(firstJson.sentMessage.channel, 'whatsapp')
    assert.equal(firstJson.sentMessage.direction, 'outbound')
    assert.equal(firstJson.sentMessage.messageType, 'template')
    assert.equal(firstJson.sentMessage.sentBy, 'system')
    assert.equal(firstJson.sentMessage.sendState, 'accepted')
    assert.equal(new Date(firstJson.sentMessage.createdAt).toISOString(), recordBody.createdAt)

    const repeated = await route.POST(request('empresa-a', recordBody, 'company-a-key'), params())
    assert.equal(repeated.status, 200, JSON.stringify(await repeated.clone().json()))
    const repeatedJson = await repeated.json()
    assert.equal(repeatedJson.idempotentReplay, true)
    assert.equal(repeatedJson.sentMessage.id, firstJson.sentMessage.id)

    const rows = await database.db.select().from(schema.whatsappMessages)
    assert.equal(rows.length, 1)
    assert.equal(transportCalls, 0)
  })

  await suite.test('a company key cannot write the same request into another company', async () => {
    await reset()
    const response = await route.POST(request('empresa-b', recordBody, 'company-a-key'), params('empresa-b'))
    assert.equal(response.status, 403)
    const rows = await database.db.select().from(schema.whatsappMessages).where(and(
      eq(schema.whatsappMessages.companyId, 2),
      eq(schema.whatsappMessages.clientRequestId, recordBody.clientRequestId),
    ))
    assert.equal(rows.length, 0)
    assert.equal(transportCalls, 0)
  })

  await suite.test('rejects malformed input before creating any lead or message', async () => {
    await reset()
    const bad: Array<Record<string, unknown>> = [
      { ...recordBody, externalId: 'not-a-wamid' },
      { ...recordBody, createdAt: '9999-12-31T23:59:59.999Z' },
      { ...recordBody, createdAt: '2026-11-08Z' },
      { ...recordBody, clientRequestId: undefined },
      { ...recordBody, sendState: 'failed' },
    ]
    for (const body of bad) {
      const response = await route.POST(request('empresa-a', body, 'company-a-key'), params('empresa-a', '5511888887777'))
      assert.equal(response.status, 400, JSON.stringify(body))
    }
    const leads = await database.db.select().from(schema.recoveryLeads)
    assert.equal(leads.length, 1)
    assert.equal((await database.db.select().from(schema.whatsappMessages)).length, 0)
    assert.equal(transportCalls, 0)
  })

  await suite.test('reusing a clientRequestId for different content or wamid is a 409, not a replay', async () => {
    await reset()
    const first = await route.POST(request('empresa-a', recordBody, 'company-a-key'), params())
    assert.equal(first.status, 201)
    const other = await route.POST(request('empresa-a', { ...recordBody, externalId: 'wamid.HBgMNTU2NTk5Mjk5MDA2FQIAERgSOTkxOTMwRkY5OEUyMEZCRjBCAA==' }, 'company-a-key'), params())
    assert.equal(other.status, 409)
    const diffContent = await route.POST(request('empresa-a', { ...recordBody, content: 'outro texto' }, 'company-a-key'), params())
    assert.equal(diffContent.status, 409)
    assert.equal((await database.db.select().from(schema.whatsappMessages)).length, 1)
  })

  await suite.test('recordOnly never creates a lead for an unknown contact, even under concurrency', async () => {
    await reset()
    const calls = await Promise.all([1, 2].map(() => route.POST(request('empresa-a', recordBody, 'company-a-key'), params('empresa-a', '5511777776666'))))
    assert.deepEqual(calls.map(r => r.status), [404, 404])
    const bad = await route.POST(request('empresa-a', recordBody, 'company-a-key'), params('empresa-a', 'sem-telefone'))
    assert.ok([400, 404].includes(bad.status))
    assert.equal((await database.db.select().from(schema.recoveryLeads)).length, 1)
    assert.equal((await database.db.select().from(schema.whatsappMessages)).length, 0)
  })
  })
}

main().catch(error => { console.error(error); process.exitCode = 1 })
