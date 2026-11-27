// Regressão do travamento do Inbox de 23/09/2026.
// Sobe Postgres real descartável, cria 2.405 conversas e chama o loader REAL
// usado pelo layout e por /api/inbox. Prova que o primeiro lote fica limitado
// a 75, que o cursor não duplica/pula linhas e que não existe teto total.

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'inbox_pagination_performance_test'
const TOTAL = 2_405

function dockerAvailable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('porta livre indisponível'))
      server.close(() => resolve(address.port))
    })
  })
}

async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await freePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ], { stdio: 'ignore' })
  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 })
      await probe`select 1`
      await probe.end({ timeout: 1 })
      return { url, stop: () => { spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' }) } }
    } catch {
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
  throw new Error('Postgres descartável não respondeu em 30s')
}

async function main() {
  if (!dockerAvailable()) throw new Error('Docker é obrigatório para este teste')
  const disposable = await startPostgres()
  try {
    execFileSync('pnpm', ['exec', 'drizzle-kit', 'push', '--force'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: disposable.url },
      stdio: 'ignore',
    })

    const client = postgres(disposable.url, { max: 10 })
    const testDb = drizzle(client, { schema })
    mock.module('@/lib/db', { namedExports: { db: testDb } })

    const [company] = await testDb.insert(schema.companies)
      .values({ name: 'Carga Inbox', slug: 'carga-inbox' }).returning()

    await client.unsafe(`
      insert into recovery_leads
        (company_id, phone, name, event_type, status, channel, bot_paused,
         created_at, updated_at, last_action_at)
      select $1,
             '5511' || lpad(gs::text, 9, '0'),
             'Lead ' || gs,
             'atendimento', 'in_conversation', 'whatsapp', false,
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second',
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second',
             timestamp '2026-09-01 00:00:00' + gs * interval '1 second'
      from generate_series(1, ${TOTAL}) gs
    `, [company.id])
    await client.unsafe(`
      insert into whatsapp_messages (company_id, lead_id, phone, direction, content, created_at)
      select company_id, id, phone,
             case when id % 2 = 0 then 'inbound' else 'outbound' end,
             'Mensagem do ' || name,
             last_action_at
      from recovery_leads where company_id = $1
    `, [company.id])

    // Uma mensagem vinculada a outro lead com o mesmo telefone não deve tornar
    // o lead duplicado uma conversa nem contaminar sua posição no Inbox.
    const [duplicateLead] = await client`
      select id, phone
      from recovery_leads
      where company_id = ${company.id}
      order by id
      offset 10 limit 1
    `
    const [duplicateMessageOwner] = await client`
      select id
      from recovery_leads
      where company_id = ${company.id}
      order by id
      offset 11 limit 1
    `
    await client`
      update recovery_leads
      set phone = ${duplicateMessageOwner.id}::text
      where id = ${duplicateLead.id}
    `
    await client`
      update whatsapp_messages
      set phone = ${duplicateMessageOwner.id}::text
      where lead_id = ${duplicateMessageOwner.id}
    `
    const duplicateProbe = await import('../src/lib/inbox-conversations')
    const duplicatePage = await duplicateProbe.loadInboxPage({ companyId: company.id, limit: TOTAL })
    assert.equal(
      duplicatePage.conversations.some(conversation => conversation.id === duplicateLead.id),
      false,
      'lead duplicado não deve herdar a mensagem vinculada a outro lead pelo telefone'
    )

    // Mensagem sem lead_id pode chegar com formatação de telefone diferente;
    // ela precisa ser a prévia e o horário da mesma conversa, sem divergir da
    // chave usada para ordenar a página.
    const [formattedLead] = await testDb.insert(schema.recoveryLeads).values({
      companyId: company.id,
      phone: '+55 (11) 90000-4242',
      name: 'Lead telefone formatado',
      eventType: 'atendimento',
      status: 'in_conversation',
      channel: 'whatsapp',
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
      lastActionAt: new Date('2026-09-01T00:00:00Z'),
    }).returning()
    const formattedAt = new Date('2026-09-03T00:00:00Z')
    await testDb.insert(schema.whatsappMessages).values({
      companyId: company.id,
      leadId: null,
      phone: '5511900004242',
      direction: 'inbound',
      content: 'mensagem sem lead com telefone normalizado',
      createdAt: formattedAt,
    })
    const formattedPage = await duplicateProbe.loadInboxPage({ companyId: company.id, limit: TOTAL + 1 })
    const formattedConversation = formattedPage.conversations.find(conversation => conversation.id === formattedLead.id)
    assert.ok(formattedConversation, 'lead com mensagem sem lead_id deveria entrar no Inbox')
    assert.equal(formattedConversation.lastMessage, 'mensagem sem lead com telefone normalizado')
    assert.equal(formattedConversation.lastMessageAt, formattedAt.toISOString())

    // Um telefone repetido entre dois leads não pode fazer a atividade de um
    // lead aparecer no cursor do outro. Mensagens sem lead_id continuam sendo
    // resolvidas por telefone; mensagens já vinculadas pertencem só ao lead.
    const [phoneSource] = await client`
      select id, phone
      from recovery_leads
      where company_id = ${company.id}
      order by id
      offset 100 limit 1
    `
    const [phoneDuplicate] = await client`
      select id
      from recovery_leads
      where company_id = ${company.id}
      order by id
      offset 2_100 limit 1
    `
    await client`
      update recovery_leads
      set phone = ${phoneSource.phone}
      where id = ${phoneDuplicate.id}
    `
    const { loadInboxPage, INBOX_PAGE_SIZE } = await import('../src/lib/inbox-conversations')

    await test('primeiro lote é pequeno e rápido mesmo com milhares de conversas', async () => {
      const started = performance.now()
      const page = await loadInboxPage({ companyId: company.id })
      const elapsedMs = performance.now() - started
      assert.equal(page.conversations.length, INBOX_PAGE_SIZE)
      assert.equal(page.hasMore, true)
      assert.ok(page.nextCursor)
      assert.ok(elapsedMs < 1_500, `primeiro lote levou ${elapsedMs.toFixed(1)}ms`)
      assert.ok(JSON.stringify(page).length < 100_000, 'lote inicial não deve recriar payload megabyte')
      console.log(`[medição] ${TOTAL} conversas: primeiro lote=${elapsedMs.toFixed(1)}ms, bytes=${JSON.stringify(page).length}`)
    })

    await test('cursor percorre tudo sem teto, duplicação ou lacuna', async () => {
      const ids: number[] = []
      let cursor: string | null = null
      let pageCount = 0
      do {
        pageCount += 1
        assert.ok(pageCount <= 100, `cursor não avançou após ${pageCount} páginas`)
        const page = await loadInboxPage({ companyId: company.id, cursor })
        ids.push(...page.conversations.map(conversation => conversation.id))
        cursor = page.nextCursor
        if (!page.hasMore) assert.equal(cursor, null)
      } while (cursor)

      assert.equal(ids.length, TOTAL)
      assert.equal(new Set(ids).size, TOTAL)
      assert.deepEqual(ids, [...ids].sort((a, b) => b - a), 'ordem deve ser estável por atividade e id')
    })

    await client.end({ timeout: 2 })
  } finally {
    disposable.stop()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
