// Regressões dos handlers reais do SAC: autenticação, autoria, referências e CAS.
// Uso: node --experimental-test-module-mocks --import tsx --test scripts/sac-access-regressions.test.ts
// PostgreSQL descartável em memória (PGlite): executa SQL Drizzle real.
// Stack/cookies são substituídos; auth.ts, políticas e handlers são os reais.
// PGlite é de conexão única: valida CAS e interleavings controlados, não carga
// ou comportamento entre múltiplas conexões de um PostgreSQL de produção.
// PGLITE_MODULE pode apontar para o módulo quando ele não estiver instalado localmente.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { eq, getTableName } from 'drizzle-orm'
import { createSacTestDatabase } from './sac-test-pglite'
import { createRequire } from 'node:module'
import { dirname, delimiter } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { NextRequest } from 'next/server'
import * as schema from '../src/lib/db/schema'
import { resolveCompanyRole } from '../src/lib/company-role'
import { canAcceptMemberInvite } from '../src/lib/member-invite-policy'

type Row = Record<string, unknown>
const fixtureTables = [schema.companies, schema.companyMembers, schema.recoveryLeads,
  schema.whatsappMessages, schema.settings, schema.sacApprovedReplies,
  schema.sacInternalNotes, schema.sacAuditEvents]
type FixtureTable = typeof fixtureTables[number]
const fixtures = new Map<string, Row[]>(fixtureTables.map(table => [getTableName(table), []]))
const records = (table: FixtureTable): Row[] => fixtures.get(getTableName(table))!
let testDb: Awaited<ReturnType<typeof createSacTestDatabase>>['db']
let pg: Awaited<ReturnType<typeof createSacTestDatabase>>['pg']
let closeDatabase: (() => Promise<void>) | undefined
let readBarrier: { table: string; count: number; waiters: Array<() => void> } | null = null
let failNextAudit = false
const databaseProxy = new Proxy({}, { get: (_target, key) => {
  const value = Reflect.get(testDb, key)
  return typeof value === 'function' ? value.bind(testDb) : value
} })

async function initializeDatabase() {
  const database = await createSacTestDatabase(fixtureTables)
  pg = database.pg; testDb = database.db; closeDatabase = database.close
  const query = pg.query.bind(pg)
  pg.query = async (statement: string, ...args: unknown[]) => {
    if (/^insert into "sac_audit_events"/i.test(statement) && failNextAudit) { failNextAudit = false; throw new Error('audit indisponível (teste)') }
    const result = await query(statement, ...args)
    if (readBarrier && /^select /i.test(statement) && statement.includes(`from "${readBarrier.table}"`)) {
      const barrier = readBarrier
      await new Promise<void>(resolve => {
        barrier.waiters.push(resolve)
        if (--barrier.count === 0) { readBarrier = null; barrier.waiters.forEach(release => release()) }
      })
    }
    return result
  }
}
async function read(table: FixtureTable, id: number): Promise<Row> {
  const [row] = await testDb.select().from(table).where(eq(table.id, id))
  return row
}
const lead = () => read(schema.recoveryLeads, 100)
async function rows(table: FixtureTable): Promise<Row[]> { return testDb.select().from(table) }
async function seed() {
  await pg.exec(`truncate ${fixtureTables.map(table => `"${getTableName(table)}"`).join(', ')} restart identity`)
  for (const table of fixtureTables) {
    const fixtureRows = records(table)
    if (!fixtureRows.length) continue
    await testDb.insert(table).values(fixtureRows as typeof table.$inferInsert[])
    const name = getTableName(table)
    // IDs explícitos das fixtures não avançam o serial automaticamente.
    await pg.exec(`select setval(pg_get_serial_sequence('"${name}"', 'id'), (select max(id) from "${name}"), true)`)
  }
}
async function mutate(table: FixtureTable, id: number, values: Row) { await testDb.update(table).set(values as Partial<typeof table.$inferInsert>).where(eq(table.id, id)) }

let session: Row | null = null
const requestSession = new AsyncLocalStorage<Row>()
let sessionCookies: Record<string, string> = {}
const mockModule = (specifier: string, namedExports: Record<string, unknown>) => (mock as unknown as { module: (specifier: string, options: { namedExports: Record<string, unknown> }) => unknown }).module(specifier, { namedExports })
// O Next fornece o marcador server-only compilado. NODE_PATH só neste
// processo de testes permite a resolução CJS do tsx sem instalar dependências.
const localRequire = createRequire(import.meta.url)
const moduleRuntime = localRequire('node:module')
const compiledRoot = dirname(dirname(localRequire.resolve('next/dist/compiled/server-only/package.json')))
process.env.NODE_PATH = [compiledRoot, process.env.NODE_PATH].filter(Boolean).join(delimiter)
moduleRuntime._initPaths()
mockModule(localRequire.resolve('server-only'), {})
mockModule('@/lib/db', { db: databaseProxy })
mockModule('@/stack', { stackServerApp: { getUser: async () => requestSession.getStore() ?? session } })
mockModule('next/headers', { cookies: async () => ({ get: (name: string) => sessionCookies[name] ? { value: sessionCookies[name] } : undefined, delete: (name: string) => { delete sessionCookies[name] } }) })
mockModule('@/lib/agent-session', { verifyAgentSessionCookie: async () => null })
// PATCH imports these transports but must never call them.
let externalCalls = 0
const noExternal = async () => { externalCalls++; throw new Error('Nenhum envio externo permitido nestes testes') }
mockModule('@/lib/whatsapp', { sendWhatsAppMessage: noExternal })
mockModule('@/lib/instagram', { sendInstagramMessage: noExternal })
mockModule('@/lib/email/brevo', { sendBrevoEmail: noExternal })
mockModule('@/lib/outbound-send', { sendOutboundForLead: noExternal })
mockModule('@/lib/leads', { markLeadContacted: noExternal })
mockModule('@/lib/email-engagement', { getEmailEngagement: async () => null })
mockModule('@/lib/inbox-messages', { decodeMessageCursor: () => null, INBOX_MESSAGE_PAGE_SIZE: 50, INBOX_MESSAGE_PAGE_SIZE_MAX: 100, loadInboxMessagePage: async () => ({ messages: [], hasMore: false, nextCursor: null }) })

async function reset(userId = 'u-operator') {
  for (const rows of fixtures.values()) rows.splice(0)
  readBarrier = null; failNextAudit = false; externalCalls = 0; sessionCookies = {}
  session = { id: userId, primaryEmail: `${userId}@example.test`, displayName: userId === 'u-operator' ? 'Operador real' : userId, primaryEmailVerified: true, isAdmin: false }
  records(schema.companies).push(
    { id: 1, name: 'Empresa A', slug: 'empresa-a', stackAuthUserId: 'u-owner', agentDisplayName: 'Luana' },
    { id: 2, name: 'Empresa B', slug: 'empresa-b', stackAuthUserId: 'u-other-owner' },
  )
  records(schema.companyMembers).push(
    { id: 10, companyId: 1, email: 'u-operator@example.test', name: 'Operador real', stackAuthUserId: 'u-operator', status: 'ativo', role: 'membro', inviteToken: null },
    { id: 11, companyId: 1, email: 'u-admin@example.test', name: 'Admin real', stackAuthUserId: 'u-admin', status: 'ativo', role: 'admin', inviteToken: null },
    { id: 12, companyId: 1, email: 'u-other@example.test', name: 'Outro operador', stackAuthUserId: 'u-other', status: 'ativo', role: 'membro', inviteToken: null },
    { id: 13, companyId: 1, email: 'pending@example.test', stackAuthUserId: null, status: 'pending', role: 'admin', inviteToken: 'secret-admin-invite' },
    { id: 20, companyId: 2, email: 'foreign@example.test', stackAuthUserId: 'u-foreign', status: 'ativo', role: 'admin', inviteToken: null },
  )
  records(schema.recoveryLeads).push(
    { id: 100, companyId: 1, phone: '5511000000100', name: 'Cliente A', status: 'pending', pipelineStage: 'novo_contato', botPaused: false, botControlVersion: 1, contextVersion: 1, humanOwnerMemberId: null, sacCaseState: 'aberto', requestSummary: 'Pedido original', nextAction: null, requestMessageId: null },
    { id: 101, companyId: 1, phone: '5511000000101', contextVersion: 1, botControlVersion: 1, humanOwnerMemberId: null, status: 'pending' },
    { id: 200, companyId: 2, phone: '5511000000200', contextVersion: 1, humanOwnerMemberId: null, status: 'pending' },
  )
  records(schema.settings).push({ id: 1, companyId: 1, pipelineColumns: [{ id: 'novo_contato', title: 'Novo' }, { id: 'agendado', title: 'Agendado' }] })
  records(schema.whatsappMessages).push(
    { id: 1000, companyId: 1, leadId: 100, phone: '5511000000100', content: 'Pedido A' },
    { id: 1001, companyId: 1, leadId: 101, phone: '5511000000100', content: 'Outro lead com mesmo telefone' },
    { id: 1002, companyId: 1, leadId: null, phone: '5511000000100', content: 'Histórico legado A' },
    { id: 2000, companyId: 2, leadId: 200, phone: '5511000000100', content: 'Outra empresa com mesmo telefone' },
  )
  records(schema.sacApprovedReplies).push(
    { id: 1, companyId: 1, title: 'Prazo', body: 'Prazo de 3 dias', shortcut: '/prazo', variables: [], version: 1, approvalState: 'approved', approvedBy: 'Admin real', approvedAt: new Date(), createdAt: new Date(), updatedAt: new Date() },
    { id: 2, companyId: 1, title: 'Rascunho', body: 'Texto pendente', shortcut: '/draft', version: 1, approvalState: 'draft', approvedBy: null, approvedAt: null, updatedAt: new Date() },
    { id: 3, companyId: 2, title: 'Segredo B', body: 'Privado B', version: 1, approvalState: 'approved', updatedAt: new Date() },
  )
  await seed()
}
function request(path: string, method: string, body?: Row) {
  return new NextRequest(`https://sac.example.test${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
}
const leadParams = (id = '100') => ({ params: Promise.resolve({ leadId: id }) })
const replyParams = (id = '1') => ({ params: Promise.resolve({ id }) })

test('SAC: handlers reais com PostgreSQL PGlite', async (suite) => {
  await initializeDatabase()
  suite.after(async () => { await closeDatabase?.() })
  const claim = await import('../src/app/api/inbox/[leadId]/claim/route')
  const inbox = await import('../src/app/api/inbox/[leadId]/route')
  const replies = await import('../src/app/api/approved-replies/route')
  const reply = await import('../src/app/api/approved-replies/[id]/route')
  const notes = await import('../src/app/api/inbox/[leadId]/notes/route')
  const note = await import('../src/app/api/inbox/[leadId]/notes/[noteId]/route')
  const members = await import('../src/app/api/members/route')
  const auth = await import('../src/lib/auth')

  await suite.test('vínculo pending ou somente e-mail não concede cargo', () => {
    const input = { companyId: 1, userId: 'u-operator', email: 'u-operator@example.test', isPlatformAdmin: false, companyOwnerUserId: 'u-owner' }
    assert.equal(resolveCompanyRole({ ...input, memberships: [{ id: 10, companyId: 1, stackAuthUserId: 'u-operator', email: input.email, role: 'admin', status: 'pending' }] }).role, null)
    assert.equal(resolveCompanyRole({ ...input, memberships: [{ id: 10, companyId: 1, stackAuthUserId: null, email: input.email, role: 'admin', status: 'ativo' }] }).role, null)
    assert.equal(resolveCompanyRole({ ...input, memberships: [{ id: 10, companyId: 2, stackAuthUserId: 'u-operator', email: input.email, role: 'admin', status: 'ativo' }] }).role, null)
  })
  await suite.test('convite exige destinatário verificado e token não consumido', () => {
    const invitation = { email: 'convidado@example.test', status: 'pending', inviteToken: 'secret', stackAuthUserId: null }
    const correct = { id: 'convidado', primaryEmail: 'CONVIDADO@example.test', primaryEmailVerified: true }
    assert.equal(canAcceptMemberInvite(invitation, correct), true)
    assert.equal(canAcceptMemberInvite(invitation, { ...correct, primaryEmail: 'intruso@example.test' }), false)
    assert.equal(canAcceptMemberInvite(invitation, { ...correct, primaryEmailVerified: false }), false)
    assert.equal(canAcceptMemberInvite({ ...invitation, inviteToken: null }, correct), false)
    assert.equal(canAcceptMemberInvite({ ...invitation, status: 'ativo', stackAuthUserId: 'outro' }, correct), false)
  })
  await suite.test('cookie de convite de admin não vincula conta de outro e-mail', async () => {
    await reset(); sessionCookies.pending_member_invite = 'secret-admin-invite'
    const access = await auth.getCompanyAccess()
    assert.equal(access.role, 'membro')
    const pending = await read(schema.companyMembers, 13)
    assert.equal(pending.status, 'pending'); assert.equal(pending.stackAuthUserId, null)
    assert.equal(pending.inviteToken, 'secret-admin-invite')
  })
  await suite.test('aceitação legítima consome o convite; cookie antigo não promove outro usuário', async () => {
    await reset('pending'); sessionCookies.pending_member_invite = 'secret-admin-invite'
    const access = await auth.getCompanyAccess()
    assert.equal(access.role, 'admin'); assert.equal(access.memberId, 13)
    const accepted = await read(schema.companyMembers, 13)
    assert.equal(accepted.status, 'ativo'); assert.equal(accepted.stackAuthUserId, 'pending')
    assert.equal(accepted.inviteToken, null)
    session = { ...session, id: 'u-operator', primaryEmail: 'u-operator@example.test', displayName: 'Operador real' }
    const replay = await auth.getCompanyAccess()
    assert.equal(replay.role, 'membro'); assert.equal(replay.memberId, 10)
    assert.equal((await read(schema.companyMembers, 13)).stackAuthUserId, 'pending')
  })
  await suite.test('e-mail administrativo sem verificação não vira admin de plataforma', async () => {
    await reset()
    session = { ...session, primaryEmail: 'dr.trafego@gmail.com', primaryEmailVerified: false }
    sessionCookies.admin_viewing = '2'
    const currentUser = await auth.getCurrentUser()
    assert.equal(currentUser?.isAdmin, false)
    const access = await auth.getCompanyAccess()
    assert.equal(access.role, 'membro'); assert.equal(access.company.id, 1)
    const response = await members.POST(request('/api/members', 'POST', { email: 'novo@example.test', role: 'admin' }))
    assert.equal(response.status, 403)
  })
  await suite.test('admin de plataforma verificado assume com vínculo auditável na empresa selecionada', async () => {
    await reset('u-platform')
    session = { ...session, primaryEmail: 'dr.trafego@gmail.com', primaryEmailVerified: true }
    sessionCookies.admin_viewing = '1'
    const access = await auth.getCompanyAccess()
    assert.equal(access.role, 'platform_admin'); assert.equal(access.company.id, 1)
    const response = await claim.POST(request('/api/inbox/100/claim', 'POST', {}), leadParams())
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const assigned = await read(schema.companyMembers, Number((await lead()).humanOwnerMemberId))
    assert.equal(assigned.stackAuthUserId, 'u-platform'); assert.equal(assigned.companyId, 1)
    assert.equal(assigned.status, 'ativo')
  })
  await suite.test('claim deriva membro e auditoria da sessão; JSON forjado não troca autor', async () => {
    await reset()
    const response = await claim.POST(request('/api/inbox/100/claim', 'POST', { memberId: 20, memberName: 'Admin forjado', expectedContextVersion: 1 }), leadParams())
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.equal((await lead()).humanOwnerMemberId, 10)
    assert.equal((await lead()).lastActionBy, 'Operador real')
    assert.equal((await lead()).contextVersion, 2)
    assert.equal((await lead()).botControlVersion, 2)
    const event = (await rows(schema.sacAuditEvents)).find(row => row.type === 'assume_case')!
    assert.equal(event.actorId, 'u-operator'); assert.equal(event.actorName, 'Operador real')
  })
  await suite.test('proprietário sem company_members recebe vínculo ativo identificável', async () => {
    await reset('u-owner')
    const response = await claim.POST(request('/api/inbox/100/claim', 'POST', {}), leadParams())
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const owner = (await rows(schema.companyMembers)).find(row => row.stackAuthUserId === 'u-owner')!
    assert.ok(owner); assert.equal(owner.status, 'ativo'); assert.equal(owner.companyId, 1)
    assert.equal((await lead()).humanOwnerMemberId, owner.id)
  })
  await suite.test('claim não rouba atendimento já atribuído a outro humano', async () => {
    await reset(); await mutate(schema.recoveryLeads, 100, { humanOwnerMemberId: 12 })
    const response = await claim.POST(request('/api/inbox/100/claim', 'POST', { expectedContextVersion: 1 }), leadParams())
    assert.equal(response.status, 409); assert.equal((await lead()).humanOwnerMemberId, 12)
    assert.equal((await rows(schema.sacAuditEvents)).length, 0)
  })
  await suite.test('dois operadores simultâneos não assumem a mesma versão', async () => {
    await reset(); readBarrier = { table: 'recovery_leads', count: 2, waiters: [] }
    const results = await Promise.all(['u-operator', 'u-other'].map(userId => requestSession.run(
      { id: userId, primaryEmail: `${userId}@example.test`, displayName: userId, primaryEmailVerified: true, isAdmin: false },
      () => claim.POST(request('/api/inbox/100/claim', 'POST', { expectedContextVersion: 1 }), leadParams()),
    )))
    assert.deepEqual(results.map(response => response.status).sort(), [200, 409])
    assert.equal((await lead()).contextVersion, 2); assert.equal((await lead()).botControlVersion, 2)
    const winner = results[0].status === 200 ? 10 : 12
    assert.equal((await lead()).humanOwnerMemberId, winner)
    assert.equal((await rows(schema.sacAuditEvents)).filter(row => row.type === 'assume_case').length, 1)
  })
  await suite.test('vínculo pendente já ligado à conta não permite assumir lead da empresa', async () => {
    await reset('pending')
    await mutate(schema.companyMembers, 13, { stackAuthUserId: 'pending' })
    const response = await claim.POST(request('/api/inbox/100/claim', 'POST', {}), leadParams())
    assert.equal(response.status, 404)
    assert.equal((await lead()).humanOwnerMemberId, null)
    assert.equal((await read(schema.companyMembers, 13)).status, 'pending')
  })
  await suite.test('claim de lead de outra empresa é recusado sem mutação', async () => {
    await reset()
    const response = await claim.POST(request('/api/inbox/200/claim', 'POST', {}), leadParams('200'))
    assert.equal(response.status, 404); assert.equal((await read(schema.recoveryLeads, 200)).humanOwnerMemberId, null)
  })
  await suite.test('PATCH exige versão e rejeita edição desatualizada', async () => {
    await reset()
    const missing = await inbox.PATCH(request('/api/inbox/100', 'PATCH', { requestSummary: 'Sobrescrito' }), leadParams())
    assert.equal(missing.status, 428)
    await mutate(schema.recoveryLeads, 100, { contextVersion: 2 })
    const stale = await inbox.PATCH(request('/api/inbox/100', 'PATCH', { expectedContextVersion: 1, requestSummary: 'Sobrescrito' }), leadParams())
    assert.equal(stale.status, 409); assert.equal((await lead()).requestSummary, 'Pedido original')
  })
  await suite.test('prazo da próxima ação preserva o dia escolhido e rejeita data impossível', async () => {
    await reset()
    const response = await inbox.PATCH(request('/api/inbox/100', 'PATCH', {
      expectedContextVersion: 1, dirtyFields: ['nextActionDueAt', 'nextAction'],
      nextActionDueAt: '2026-10-09', nextAction: 'Enviar orçamento',
    }), leadParams())
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.equal(new Date((await lead()).nextActionDueAt as string).toISOString(), '2026-10-09T15:00:00.000Z')
    const invalid = await inbox.PATCH(request('/api/inbox/100', 'PATCH', {
      expectedContextVersion: 2, dirtyFields: ['nextActionDueAt'], nextActionDueAt: '2026-02-30',
    }), leadParams())
    assert.equal(invalid.status, 400)
    assert.equal((await lead()).contextVersion, 2)
  })
  await suite.test('PATCH valida responsável ativo e mesma empresa antes de gravar qualquer campo', async () => {
    for (const invalidId of [20, 13, 999]) {
      await reset()
      const response = await inbox.PATCH(request('/api/inbox/100', 'PATCH', { expectedContextVersion: 1, humanOwnerMemberId: invalidId, requestSummary: 'Não gravar' }), leadParams())
      assert.equal(response.status, 400, `responsável ${invalidId}: ${JSON.stringify(await response.clone().json())}`)
      assert.equal((await lead()).requestSummary, 'Pedido original'); assert.equal((await lead()).contextVersion, 1)
    }
  })
  await suite.test('PATCH referência de outra conversa ou empresa é rejeitada, mesmo telefone', async () => {
    for (const invalidId of [1001, 2000, 999]) {
      await reset()
      const response = await inbox.PATCH(request('/api/inbox/100', 'PATCH', { expectedContextVersion: 1, requestMessageId: invalidId, commitment: 'Não gravar' }), leadParams())
      assert.equal(response.status, 400, JSON.stringify(await response.clone().json()))
      assert.equal((await lead()).requestMessageId, null); assert.equal((await lead()).contextVersion, 1)
    }
  })
  await suite.test('PATCH aceita mensagem própria e legado exato, preserva campos não alterados', async () => {
    for (const messageId of [1000, 1002]) {
      await reset()
      const response = await inbox.PATCH(request('/api/inbox/100', 'PATCH', { expectedContextVersion: 1, dirtyFields: ['requestMessageId', 'nextAction'], requestMessageId: messageId, nextAction: 'Confirmar prazo', requestSummary: 'Valor velho do formulário' }), leadParams())
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
      assert.equal((await lead()).requestMessageId, messageId); assert.equal((await lead()).nextAction, 'Confirmar prazo')
      assert.equal((await lead()).requestSummary, 'Pedido original'); assert.equal((await lead()).contextVersion, 2)
      assert.equal(externalCalls, 0)
    }
  })
  await suite.test('PATCH duas edições simultâneas: um sucesso e um 409', async () => {
    await reset(); readBarrier = { table: 'recovery_leads', count: 2, waiters: [] }
    const results = await Promise.all(['primeiro', 'segundo'].map(text => inbox.PATCH(request('/api/inbox/100', 'PATCH', { expectedContextVersion: 1, dirtyFields: ['nextAction'], nextAction: text }), leadParams())))
    assert.deepEqual(results.map(response => response.status).sort(), [200, 409])
    assert.equal((await lead()).contextVersion, 2)
    assert.equal((await rows(schema.sacAuditEvents)).filter(row => row.type === 'context_updated').length, 1)
  })
  await suite.test('PATCH rejeita enum ou etapa inexistente sem mudar pipeline', async () => {
    for (const body of [{ sacCaseState: 'estado-inventado' }, { pipelineStage: 'outra-empresa' }, { dirtyFields: ['botPaused'], botPaused: true }]) {
      await reset()
      const response = await inbox.PATCH(request('/api/inbox/100', 'PATCH', { expectedContextVersion: 1, ...body }), leadParams())
      assert.equal(response.status, 400); assert.equal((await lead()).pipelineStage, 'novo_contato'); assert.equal((await lead()).botPaused, false)
    }
  })
  await suite.test('falha da auditoria de claim gera log observável, sem fingir atomicidade', async () => {
    await reset(); failNextAudit = true
    const errors: unknown[][] = []
    const logger = mock.method(console, 'error', (...args: unknown[]) => { errors.push(args) })
    try {
      const response = await claim.POST(request('/api/inbox/100/claim', 'POST', { expectedContextVersion: 1 }), leadParams())
      assert.equal(response.status, 200)
      assert.equal((await lead()).humanOwnerMemberId, 10)
      assert.equal((await rows(schema.sacAuditEvents)).length, 0)
      assert.equal(errors.length, 1)
      assert.match(String(errors[0][0]), /audit/i)
      assert.equal(JSON.stringify(errors).includes('Pedido original'), false)
    } finally { logger.mock.restore() }
  })
  await suite.test('picker retorna somente aprovadas da própria empresa por padrão', async () => {
    await reset()
    const response = await replies.GET(request('/api/approved-replies', 'GET'))
    assert.equal(response.status, 200)
    const json = await response.json()
    assert.deepEqual(json.replies.map((row: Row) => row.id), [1])
  })
  await suite.test('operador cria rascunho e não consegue aprovar ou depreciar', async () => {
    await reset()
    const response = await replies.POST(request('/api/approved-replies', 'POST', { title: 'Nova', body: 'Texto' }))
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    const created = (await response.json()).reply
    assert.equal(created.approvalState, 'draft'); assert.equal(created.approvedBy, null)
    for (const approvalState of ['approved', 'deprecated']) {
      const forbidden = await replies.POST(request('/api/approved-replies', 'POST', { title: 'Nova', body: 'Texto', approvalState }))
      assert.equal(forbidden.status, 403)
    }
  })
  await suite.test('admin aprova com identidade humana real; enum inválido é recusado', async () => {
    await reset('u-admin')
    const response = await replies.POST(request('/api/approved-replies', 'POST', { title: 'Nova', body: 'Texto', approvalState: 'approved' }))
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    assert.equal((await response.json()).reply.approvedBy, 'u-admin')
    const bad = await replies.POST(request('/api/approved-replies', 'POST', { title: 'Nova', body: 'Texto', approvalState: 'inventado' }))
    assert.equal(bad.status, 400)
  })
  await suite.test('atalho duplicado da empresa retorna 409 pelo índice PostgreSQL real', async () => {
    await reset('u-admin')
    const response = await replies.POST(request('/api/approved-replies', 'POST', { title: 'Outra', body: 'Outro prazo', shortcut: '/prazo' }))
    assert.equal(response.status, 409, JSON.stringify(await response.clone().json()))
    assert.equal((await rows(schema.sacApprovedReplies)).length, 3)
  })
  await suite.test('editar texto aprovado invalida aprovação; aprovação por operador retorna 403', async () => {
    await reset('u-admin')
    const response = await reply.PATCH(request('/api/approved-replies/1', 'PATCH', { expectedVersion: 1, body: 'Prazo alterado' }), replyParams())
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const edited = (await response.json()).reply
    assert.equal(edited.approvalState, 'draft'); assert.equal(edited.approvedBy, null); assert.equal(edited.approvedAt, null); assert.equal(edited.version, 2)
    session = { ...session, id: 'u-operator', primaryEmail: 'u-operator@example.test', displayName: 'Operador real' }
    const forbidden = await reply.PATCH(request('/api/approved-replies/1', 'PATCH', { expectedVersion: 2, approvalState: 'approved' }), replyParams())
    assert.equal(forbidden.status, 403)
  })
  await suite.test('resposta aprovada PATCH e DELETE desatualizados não apagam versão nova', async () => {
    await reset('u-admin')
    await mutate(schema.sacApprovedReplies, 1, { version: 2 })
    const patch = await reply.PATCH(request('/api/approved-replies/1', 'PATCH', { expectedVersion: 1, body: 'Velho' }), replyParams())
    const deletion = await reply.DELETE(request('/api/approved-replies/1', 'DELETE', { expectedVersion: 1 }), replyParams())
    assert.equal(patch.status, 409); assert.equal(deletion.status, 409)
    assert.equal((await read(schema.sacApprovedReplies, 1)).body, 'Prazo de 3 dias')
  })
  await suite.test('nota forjada conserva autoria autenticada e nunca chama transporte', async () => {
    await reset()
    const response = await notes.POST(request('/api/inbox/100/notes', 'POST', { body: 'Nota privada', authorId: 'u-admin', authorName: 'Admin forjado' }), leadParams())
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    const created = (await response.json()).note
    assert.equal(created.authorId, 'u-operator'); assert.equal(created.authorName, 'Operador real')
    assert.equal(externalCalls, 0)
  })
  await suite.test('operador não apaga nota alheia; autor e admin podem apagar', async () => {
    for (const user of ['u-operator', 'u-other', 'u-admin']) {
      await reset(user)
      await testDb.insert(schema.sacInternalNotes).values({ id: 1, companyId: 1, leadId: 100, body: 'Nota alheia', authorId: 'u-other', authorName: 'Outro', authorType: 'human', deletedAt: null, createdAt: new Date(), updatedAt: new Date() })
      const response = await note.DELETE(request('/api/inbox/100/notes/1', 'DELETE'), { params: Promise.resolve({ leadId: '100', noteId: '1' }) })
      assert.equal(response.status, user === 'u-operator' ? 404 : 200, JSON.stringify(await response.clone().json()))
      assert.equal(Boolean((await read(schema.sacInternalNotes, 1)).deletedAt), user !== 'u-operator')
    }
  })
  await suite.test('GET membros não expõe inviteToken ou aceita administrar por operador', async () => {
    await reset()
    const response = await members.GET()
    assert.equal(response.status, 200)
    const json = await response.json()
    assert.equal(JSON.stringify(json).includes('secret-admin-invite'), false)
    assert.ok(json.members.every((row: Row) => !Object.hasOwn(row, 'inviteToken')))
    const forbidden = await members.POST(request('/api/members', 'POST', { email: 'intruso@example.test', role: 'admin' }))
    assert.equal(forbidden.status, 403)
  })
})
