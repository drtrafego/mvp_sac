import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'sync_drlucas_mirror_test'

async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('porta indisponível'))
      server.close(() => resolve(address.port))
    })
  })
}

async function main() {
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('Docker indisponível')
  }

  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await freePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ])
  const databaseUrl = `postgres://postgres:test@127.0.0.1:${port}/test`
  let sourceSql: ReturnType<typeof postgres> | null = null

  try {
    const deadline = Date.now() + 30_000
    while (true) {
      try {
        sourceSql = postgres(databaseUrl, { max: 1, connect_timeout: 2 })
        await sourceSql`select 1`
        break
      } catch (error) {
        await sourceSql?.end({ timeout: 1 }).catch(() => undefined)
        sourceSql = null
        if (Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }

    execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    })

    await sourceSql.unsafe(`
      create schema drlucas;
      create table drlucas.agendamentos (
        id uuid primary key, nome text not null, telefone text, telefone_norm text,
        data_consulta timestamptz not null, status text not null, origem text,
        cancelado_em timestamptz, synced_at timestamptz not null
      );
      create table drlucas.crm_columns (
        id uuid primary key, title text not null, "order" integer not null, color text, created_at timestamptz default now()
      );
      create table drlucas.crm_leads (
        id uuid primary key, column_id uuid not null references drlucas.crm_columns(id),
        name text not null, phone text, email text, notes text, company text, value numeric,
        first_contact_at timestamptz, status text, follow_up_date timestamptz,
        follow_up_note text, created_at timestamptz not null default now()
      );
      create table drlucas.conversations (
        session_id text primary key, chat_id text, channel text, title text,
        started_at timestamp, ended_at timestamp, message_count integer
      );
      create table drlucas.messages (
        id text primary key, session_id text, role text, content text, ts timestamp, platform_message_id text
      );
    `)

    await sourceSql`
      insert into drlucas.crm_columns (id, title, "order") values
        ('11111111-1111-1111-1111-111111111111', 'Novo Contato', 0),
        ('22222222-2222-2222-2222-222222222222', 'Consulta Agendada', 2)
    `
    await sourceSql`
      insert into drlucas.agendamentos
        (id, nome, telefone, telefone_norm, data_consulta, status, origem, cancelado_em, synced_at)
      values
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Paciente Teste', '5511999990123', '5511999990123',
         '2026-10-01T15:00:00Z', 'agendado', 'bot_whatsapp', null, '2026-09-23T10:00:00Z'),
        ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Paciente Cancelado', '5511888880456', '5511888880456',
         '2026-10-02T15:00:00Z', 'agendado', 'bot_whatsapp', '2026-09-23T09:00:00Z', '2026-09-23T10:01:00Z')
    `
    await sourceSql`
      insert into drlucas.crm_leads (id, column_id, name, phone, status)
      values ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111',
              'Paciente Teste', '5511999990123', 'active')
    `

    const targetDb = drizzle(sourceSql, { schema })
    const [company] = await targetDb.insert(schema.companies).values({ name: 'Dr. Lucas', slug: 'drlucas' }).returning()
    await targetDb.insert(schema.recoveryLeads).values({
      companyId: company.id,
      phone: '5511999990123',
      name: 'Paciente Teste',
      eventType: 'atendimento_ia',
      platform: 'sac',
    })

    mock.module('@/lib/db', { namedExports: { db: targetDb } })
    mock.module('@/lib/db/agents-db', {
      namedExports: {
        getAgentsDbUrl: async () => 'postgres://masked/test',
        queryAgentsDb: async (query: string, params: unknown[] = []) => {
          if (query.includes('from public.agents')) {
            return [{
              id: 'agent-lucas', organization_id: 'org-lucas', org_slug: 'drlucas',
              org_name: 'Dr. Lucas', slug: 'drlucas', schema_name: 'drlucas', name: 'Clara',
            }]
          }
          if (query.includes('from public.outreach_convos') || query.includes('from public.outreach_msgs') ||
              query.includes('from public.leads') || query.includes('from public.ctwa_referrals')) return []
          return sourceSql!.unsafe(query, params as never[])
        },
      },
    })

    const { syncAgentsAndCompanies } = await import('../src/lib/sync-agents')
    const first = await syncAgentsAndCompanies()
    assert.equal(first.ok, true)

    await test('espelha consultas reais, inclusive cancelamento, e grava cursor', async () => {
      const mirrored = await targetDb.select().from(schema.appointmentMirror)
      assert.equal(mirrored.length, 2)
      assert.equal(mirrored.find(row => row.nativeId.startsWith('bbbb'))?.cancelledAt?.toISOString(), '2026-09-23T09:00:00.000Z')
      const cursors = await targetDb.select().from(schema.syncCursors).where(eq(schema.syncCursors.source, 'appointments'))
      assert.equal(cursors.length, 1)
      assert.equal(cursors[0].newestSyncedId, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    })

    await test('reconcilia estágio e status do CRM nativo no recoveryLeads', async () => {
      const [lead] = await targetDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.phone, '5511999990123'))
      assert.equal(lead.pipelineStage, 'novo_contato')
      assert.equal(lead.status, 'active')
    })

    await sourceSql`
      update drlucas.agendamentos
      set status = 'cancelado', cancelado_em = '2026-09-23T11:00:00Z', synced_at = '2026-09-23T11:01:00Z'
      where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    `
    await sourceSql`
      update drlucas.crm_leads
      set column_id = '22222222-2222-2222-2222-222222222222',
          follow_up_date = '2026-09-30T15:00:00Z', follow_up_note = 'Confirmar consulta'
      where id = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    `
    await syncAgentsAndCompanies()

    await test('segunda rodada aplica update incremental da agenda e mudança em CRM antigo', async () => {
      const [appointment] = await targetDb.select().from(schema.appointmentMirror)
        .where(eq(schema.appointmentMirror.nativeId, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'))
      assert.equal(appointment.status, 'cancelado')
      assert.equal(appointment.cancelledAt?.toISOString(), '2026-09-23T11:00:00.000Z')

      const [lead] = await targetDb.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.phone, '5511999990123'))
      assert.equal(lead.pipelineStage, 'agendado')
      assert.equal(lead.followUpDate?.toISOString(), '2026-09-30T15:00:00.000Z')
      assert.equal(lead.followUpNote, 'Confirmar consulta')
    })
  } finally {
    await sourceSql?.end({ timeout: 2 }).catch(() => undefined)
    spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
