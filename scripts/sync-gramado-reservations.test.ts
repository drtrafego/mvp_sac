import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'

const ROOT = path.resolve(__dirname, '..')
const CONTAINER = 'sync_gramado_reservations_test'

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
    throw new Error('Docker não disponível')
  }
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
  const port = await freePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ])
  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  let sqlClient: ReturnType<typeof postgres> | null = null
  try {
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        sqlClient = postgres(url, { max: 1, connect_timeout: 2 })
        await sqlClient`select 1`
        break
      } catch {
        await sqlClient?.end({ timeout: 1 }).catch(() => {})
        sqlClient = null
        await new Promise(resolve => setTimeout(resolve, 300))
      }
    }
    if (!sqlClient) throw new Error('Postgres descartável não iniciou')

    execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'ignore',
    })
    const db = drizzle(sqlClient, { schema })
    const [company] = await db.insert(schema.companies)
      .values({ name: 'Gramado Plaza', slug: 'gramado-plaza' }).returning()
    const [lead] = await db.insert(schema.recoveryLeads).values({
      companyId: company.id,
      phone: '5551999999000',
      name: 'Cliente teste',
      eventType: 'atendimento_ia',
      platform: 'sac',
      status: 'in_conversation',
    }).returning()

    let reservationStatus = 'pendente'
    let reservationUpdatedAt = '2026-09-23T10:00:00Z'
    let crmStatus = 'Novo Contato'
    let crmFollowUpDate: string | null = null
    let crmFollowUpNote: string | null = null

    mock.module('@/lib/db', { namedExports: { db } })
    mock.module('@/lib/db/agents-db', {
      namedExports: {
        getAgentsDbUrl: async () => 'postgres://agents.example/test',
        queryAgentsDb: async (query: string, params: unknown[] = []) => {
          if (query.includes('from public.agents')) return [{
            id: 'agent-gramado', organization_id: 'org-gramado',
            org_slug: 'gramado-plazza', org_name: 'Gramado Plazza',
            slug: 'gramadoplazza', schema_name: 'gramadoplazza', name: 'Gabi',
          }]
          if (query.includes('information_schema.tables')) return [{ exists: false }]
          if (query.includes('information_schema.columns')) return []
          if (query.includes('from "gramadoplazza".conversations')) return []
          if (query.includes('from "gramadoplazza".reservas')) {
            const row = {
              reserva_id: '00000000-0000-0000-0000-000000000001',
              data: '2026-09-30', horario_reservado: '20:15:00', horario_chegada: null,
              telefone_norm: '5551999999000', pessoas: 4, valor_total: '239.60',
              status: reservationStatus, observacoes: 'teste sintético', mesas_unificadas: false,
              atualizado_em: reservationUpdatedAt, criado_em: '2026-09-23T10:00:00Z',
              sincronizado_em: reservationUpdatedAt,
              __sync_sort_at: reservationUpdatedAt,
              __sync_cursor_id: '00000000-0000-0000-0000-000000000001',
            }
            if (query.includes(' > ($1::timestamptz')) {
              return new Date(reservationUpdatedAt) > new Date(String(params[0])) ? [row] : []
            }
            if (query.includes(' < ($1::timestamptz')) return []
            return [row]
          }
          if (query.includes('from "gramadoplazza".crm_leads l')) return [{
            id: 'crm-1', column_id: 'column-1', column_title: crmStatus,
            phone: '5551999999000', status: crmStatus,
            follow_up_date: crmFollowUpDate, follow_up_note: crmFollowUpNote,
          }]
          if (query.includes('from public.outreach_convos')) return []
          if (query.includes('from public.outreach_msgs')) return []
          if (query.includes('from public.leads')) return []
          if (query.includes('from public.ctwa_referrals')) return []
          return []
        },
      },
    })

    const { syncAgentsAndCompanies } = await import('../src/lib/sync-agents')
    await syncAgentsAndCompanies()

    await test('cria espelho e liga reserva ao lead sem duplicar dado pessoal cru', async () => {
      const rows = await db.select().from(schema.gramadoReservations)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].leadId, lead.id)
      assert.equal(rows[0].status, 'pendente')
      assert.equal(rows[0].valorTotal, '239.60')
    })

    reservationStatus = 'cancelou'
    reservationUpdatedAt = '2026-09-23T11:00:00Z'
    crmStatus = 'Perdido'
    crmFollowUpDate = '2026-09-23T10:30:00Z'
    crmFollowUpNote = 'Follow-up Gramado: 10min enviado'
    await syncAgentsAndCompanies()

    await test('cursor captura atualização antiga e CRM/follow-up nativos', async () => {
      const rows = await db.select().from(schema.gramadoReservations)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].status, 'cancelou')
      const [updatedLead] = await db.select().from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.id, lead.id))
      assert.equal(updatedLead.pipelineStage, 'perdido')
      assert.equal(updatedLead.status, 'lost')
      assert.equal(updatedLead.followUpNote, crmFollowUpNote)
      assert.equal(updatedLead.followUpDate?.toISOString(), new Date(crmFollowUpDate!).toISOString())
    })
  } finally {
    await sqlClient?.end({ timeout: 1 }).catch(() => {})
    spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
