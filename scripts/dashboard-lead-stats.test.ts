import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { dashboardLeadStatsSelect, gramadoDashboardCardCounts } from '../src/lib/dashboard/lead-stats'

function whatsappMsg(companyId: number, leadId: number, direction: 'inbound' | 'outbound', minutesAfterNow: number) {
  return {
    companyId,
    leadId,
    phone: '5599999999999',
    direction,
    content: direction === 'inbound' ? 'oi, quero saber mais' : 'claro, posso ajudar',
    createdAt: new Date(NOW.getTime() + minutesAfterNow * 60_000),
  }
}

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'dashboard_lead_stats_test'
const NOW = new Date('2026-09-22T12:00:00.000Z')

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return r.status === 0
}

async function pickFreePortAsync(): Promise<number> {
  const net = await import('node:net')
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('nao deu para alocar porta livre')))
      }
    })
  })
}

async function startDisposablePostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await pickFreePortAsync()
  console.log(`[setup] subindo postgres:16-alpine descartavel na porta ${port}...`)
  execFileSync('docker', [
    'run', '--rm', '-d',
    '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test',
    '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`,
    'postgres:16-alpine',
  ])

  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 })
      await probe`select 1`
      await probe.end({ timeout: 1 })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, 500))
    }
  }

  if (lastErr) throw new Error(`postgres descartavel nao respondeu a tempo: ${String(lastErr)}`)

  return {
    url,
    stop: () => {
      console.log('[teardown] derrubando container descartavel...')
      spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
    },
  }
}

function applyRealSchema(databaseUrl: string) {
  console.log('[setup] aplicando schema real via drizzle-kit push...')
  execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  })
}

function lead(companyId: number, phoneSuffix: string, values: Partial<typeof schema.recoveryLeads.$inferInsert>) {
  return {
    companyId,
    platform: 'sac',
    eventType: 'atendimento_ia',
    phone: `559999${phoneSuffix.padStart(7, '0')}`,
    status: 'in_conversation',
    productValue: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...values,
  }
}

async function main() {
  if (!dockerAvailable()) {
    console.error('Docker nao disponivel: este teste precisa de Postgres real.')
    process.exitCode = 1
    return
  }

  const disposable = await startDisposablePostgres()
  applyRealSchema(disposable.url)

  const sql = postgres(disposable.url)
  const testDb = drizzle(sql, { schema })

  try {
    await testDb.insert(schema.companies).values([
      { id: 3, name: 'Dr. Lucas', slug: 'drlucas' },
      { id: 4, name: 'Gramado Plaza', slug: 'gramado-plaza' },
      { id: 6, name: 'Gramado Engajamento Teste', slug: 'gramado-engajamento-teste' },
      { id: 7, name: 'AutonomIA Teste', slug: 'autonomia-teste' },
      { id: 10, name: 'Checkout Teste', slug: 'checkout-teste' },
    ])

    await test('Gramado conta status real "Reserva Confirmada" sem duplicar no funil', async () => {
      await testDb.insert(schema.recoveryLeads).values([
        lead(4, '1', { status: 'Reserva Confirmada', firstContactAt: null, productValue: 18000 }),
        lead(4, '2', { status: 'Reserva Confirmada', firstContactAt: NOW, productValue: 20000 }),
        lead(4, '3', { pipelineStage: 'reserva_confirmada', firstContactAt: NOW, productValue: 22000 }),
        lead(4, '4', { status: 'Reserva Confirmada', pipelineStage: 'compareceu', firstContactAt: NOW, productValue: 30000 }),
        lead(4, '5', { status: 'Novo Contato', eventType: 'prospeccao', firstContactAt: NOW }),
        lead(4, '6', { status: 'in_conversation', eventType: 'atendimento_ia', firstContactAt: NOW }),
        lead(4, '7', { status: 'Perdido', eventType: 'prospeccao', firstContactAt: NOW }),
        lead(4, '8', { status: 'Data Consultada', firstContactAt: NOW }),
        lead(4, '9', { status: 'Cardápio / Pacote', firstContactAt: NOW }),
        lead(4, '10', { status: 'completed', pipelineStage: 'agendado', eventType: 'reserva_confirmada', firstContactAt: null, productValue: 40000 }),
      ])

      const [stats] = await testDb
        .select(dashboardLeadStatsSelect('gramado'))
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 4))

      assert.equal(stats.total, 8)
      assert.equal(stats.fechadosTotal, 5)
      assert.equal(Number(stats.valorFechadoCents), 130000)
      assert.equal(stats.novoContato, 2)
      assert.equal(stats.qualificado, 1)
      assert.equal(stats.proposta, 1)
      assert.equal(stats.fechado, 4)
      assert.equal(stats.compareceu, 1)
      assert.equal(stats.perdido, 1)

      const cards = gramadoDashboardCardCounts(stats)
      assert.equal(cards.reservaConfirmada, 5, 'Reserva Confirmada deve incluir pipeline_stage=agendado')
      assert.equal(cards.compareceu, 5, 'Compareceu deve usar a mesma metrica cumulativa de negocio ganho')
    })

    await test('Dr. Lucas usa pipeline agendado como consulta agendada e nao como novo contato', async () => {
      await testDb.insert(schema.recoveryLeads).values([
        lead(3, '101', { status: 'active', eventType: 'atendimento', pipelineStage: 'agendado', firstContactAt: NOW }),
        lead(3, '102', { status: 'active', eventType: 'atendimento', pipelineStage: null, firstContactAt: NOW }),
        lead(3, '103', { status: 'in_conversation', eventType: 'atendimento_ia', pipelineStage: null, firstContactAt: null }),
        lead(3, '104', { status: 'active', eventType: 'atendimento', pipelineStage: 'novo_contato', firstContactAt: NOW }),
        lead(3, '105', { status: 'Consulta Agendada', eventType: 'atendimento', firstContactAt: NOW }),
        lead(3, '106', { status: 'active', eventType: 'atendimento', pipelineStage: 'procedimento_realizado', firstContactAt: NOW }),
        lead(3, '107', { status: 'in_conversation', eventType: 'atendimento_ia', pipelineStage: 'agendado', firstContactAt: null }),
      ])

      const [stats] = await testDb
        .select(dashboardLeadStatsSelect('lucas'))
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 3))

      assert.equal(stats.total, 5)
      assert.equal(stats.fechadosTotal, 4)
      assert.equal(stats.agendado, 3)
      assert.equal(stats.fechado, 1)
      assert.equal(stats.novoContato, 3)
    })

    await test('vocabulário de restaurante nao vaza para checkouts', async () => {
      await testDb.insert(schema.recoveryLeads).values([
        lead(10, '201', { platform: 'kiwify', status: 'approved', eventType: 'compra_aprovada', firstContactAt: NOW, productValue: 10000 }),
        lead(10, '202', { platform: 'hotmart', status: 'completed', eventType: 'compra_aprovada', firstContactAt: NOW, productValue: 12000 }),
        lead(10, '203', { platform: 'sac', status: 'Reserva Confirmada', eventType: 'atendimento_ia', firstContactAt: NOW, productValue: 18000 }),
      ])

      const [stats] = await testDb
        .select(dashboardLeadStatsSelect('infoproduto'))
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 10))

      assert.equal(stats.fechadosTotal, 2)
      assert.equal(stats.fechado, 2)
      assert.equal(Number(stats.valorFechadoCents), 22000)
      assert.equal(stats.novoContato, 1)
    })

    await test('funil de engajamento (Responderam/Avançaram) bate com o historico real de mensagens, nao com o CRM', async () => {
      const inserted = await testDb
        .insert(schema.recoveryLeads)
        .values([
          lead(6, '301', { status: 'Novo Contato', firstContactAt: NOW }), // A: sem mensagem alguma
          lead(6, '302', { status: 'Novo Contato', firstContactAt: NOW }), // B: respondeu, nao avancou
          lead(6, '303', { status: 'Novo Contato', firstContactAt: NOW }), // C: respondeu e avancou (4+ msgs)
          lead(6, '304', { status: 'Novo Contato', firstContactAt: NOW }), // D: 3 msgs so outbound, nao respondeu
          lead(6, '305', { status: 'Novo Contato', firstContactAt: null }), // E: nunca abordado, fora do total
        ])
        .returning({ id: schema.recoveryLeads.id, phone: schema.recoveryLeads.phone })

      const byPhoneSuffix = (suffix: string) =>
        inserted.find(l => l.phone.endsWith(suffix.padStart(7, '0')))!.id

      const leadB = byPhoneSuffix('302')
      const leadC = byPhoneSuffix('303')
      const leadD = byPhoneSuffix('304')
      const leadE = byPhoneSuffix('305')

      await testDb.insert(schema.whatsappMessages).values([
        whatsappMsg(6, leadB, 'inbound', 1),

        whatsappMsg(6, leadC, 'outbound', 1),
        whatsappMsg(6, leadC, 'inbound', 2),
        whatsappMsg(6, leadC, 'outbound', 3),
        whatsappMsg(6, leadC, 'inbound', 4),

        whatsappMsg(6, leadD, 'outbound', 1),
        whatsappMsg(6, leadD, 'outbound', 2),
        whatsappMsg(6, leadD, 'outbound', 3),

        // Lead nunca abordado (firstContactAt nulo): mesmo com 5 mensagens
        // presas a ele por engano, nao pode vazar para o funil de engajamento.
        whatsappMsg(6, leadE, 'inbound', 1),
        whatsappMsg(6, leadE, 'inbound', 2),
        whatsappMsg(6, leadE, 'inbound', 3),
        whatsappMsg(6, leadE, 'inbound', 4),
        whatsappMsg(6, leadE, 'inbound', 5),
      ])

      const [stats] = await testDb
        .select(dashboardLeadStatsSelect('gramado'))
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 6))

      assert.equal(stats.total, 4, 'total conta so quem foi abordado (A, B, C, D)')
      assert.equal(stats.respondeuTotal, 2, 'so B e C mandaram mensagem inbound')
      assert.equal(stats.avancouTotal, 1, 'so C chegou a 4+ mensagens na conversa')
    })

    await test('agencia: taxa de conversao (agendado+fechado / conversas iniciadas) bate com o painel nativo', async () => {
      await testDb.insert(schema.recoveryLeads).values([
        lead(7, '401', { pipelineStage: 'contrato_fechado', firstContactAt: NOW, productValue: 500000 }),
        lead(7, '402', { pipelineStage: 'contrato_fechado', firstContactAt: NOW, productValue: 300000 }),
        lead(7, '403', { pipelineStage: 'reuniao_agendada', firstContactAt: NOW }),
        lead(7, '404', { pipelineStage: 'em_atendimento', firstContactAt: NOW }),
        lead(7, '405', { pipelineStage: 'em_atendimento', firstContactAt: NOW }),
        lead(7, '406', { status: 'Perdido', firstContactAt: NOW }),
        lead(7, '407', { pipelineStage: 'novo_contato', firstContactAt: null }), // fora do total
      ])

      const [stats] = await testDb
        .select(dashboardLeadStatsSelect('agencia'))
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 7))

      assert.equal(stats.total, 6)
      assert.equal(stats.fechadosTotal, 3, 'agendado (1) + fechado (2) contam como negocio ganho na agencia')
      assert.equal(stats.agendado, 1)
      assert.equal(stats.fechado, 2)
      assert.equal(stats.qualificado, 2)
      assert.equal(stats.perdido, 1)
      assert.equal(Number(stats.valorFechadoCents), 800000)

      const conversionRate = stats.total > 0 ? (stats.fechadosTotal / stats.total) * 100 : 0
      assert.equal(conversionRate.toFixed(1), '50.0')
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: dashboard-lead-stats passou contra Postgres descartavel real.')
  })
  .catch(err => {
    console.error('Erro fatal no teste dashboard-lead-stats:', err)
    process.exitCode = 1
  })
