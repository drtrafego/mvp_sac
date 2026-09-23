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
      { id: 11, name: 'Isabela Fanini Teste', slug: 'isabela-fanini-teste' },
      { id: 12, name: 'Checkout Sem Conversa Teste', slug: 'checkout-sem-conversa-teste' },
      { id: 13, name: 'Isabela Fanini Teste 2', slug: 'isabela-fanini-teste-2' },
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
    await test('infoproduto: venda direta e venda recuperada nao se misturam, e a soma bate com o total aprovado', async () => {
      await testDb.insert(schema.recoveryLeads).values([
        // Venda direta: compra aprovada de primeira, telefone nunca teve
        // nenhum evento de carrinho abandonado / boleto / pix / cartao
        // recusado nesta empresa.
        lead(11, '501', {
          platform: 'hotmart',
          eventType: 'compra_aprovada',
          status: 'completed',
          firstContactAt: NOW,
          productValue: 15000,
        }),

        // Venda recuperada: o MESMO telefone abandonou o carrinho antes (linha
        // marcada como convertida via mensagem do sistema) e so depois a
        // compra foi aprovada (segunda linha, mesmo valor do pedido).
        lead(11, '502', {
          platform: 'hotmart',
          eventType: 'carrinho_abandonado',
          status: 'converted',
          convertedFrom: 'msg_2',
          firstContactAt: NOW,
          productValue: 8000,
        }),
        lead(11, '502', {
          platform: 'hotmart',
          eventType: 'compra_aprovada',
          status: 'completed',
          firstContactAt: NOW,
          productValue: 8000,
        }),

        // Pegadinha temporal: MESMO telefone de uma venda direta (503) abandona
        // um carrinho DEPOIS de ja ter comprado (compra as 12h, abandono as
        // 13h, de um pedido totalmente diferente). Sem o corte por created_at
        // <= data da aprovacao, essa venda direta seria classificada por
        // engano como "recuperada", so porque compartilha o telefone com um
        // abandono que aconteceu DEPOIS dela.
        lead(11, '503', {
          platform: 'hotmart',
          eventType: 'compra_aprovada',
          status: 'completed',
          firstContactAt: NOW,
          productValue: 5000,
          createdAt: NOW,
        }),
        lead(11, '503', {
          platform: 'hotmart',
          eventType: 'carrinho_abandonado',
          status: 'pending',
          firstContactAt: NOW,
          productValue: 5000,
          createdAt: new Date(NOW.getTime() + 60 * 60_000),
        }),
      ])

      const [stats] = await testDb
        .select(dashboardLeadStatsSelect('infoproduto'))
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 11))

      assert.equal(stats.aprovada, 3, 'as tres linhas de compra_aprovada contam no total de aprovadas')
      assert.equal(Number(stats.aprovadaValueCents), 28000, '15000 (direta) + 8000 (recuperada) + 5000 (direta com abandono POSTERIOR)')

      assert.equal(stats.directCount, 2, 'venda direta conta 501 e 503 (o abandono de 503 aconteceu DEPOIS da compra, nao antes)')
      assert.equal(Number(stats.directValueCents), 20000, '15000 + 5000: o abandono posterior de 503 nao pode contaminar a venda direta')

      assert.equal(stats.recoveredCount, 1, 'so a linha de abandono convertida por mensagem conta como recuperada')
      assert.equal(Number(stats.recoveredValueCents), 8000, 'receita recuperada nao inclui a venda direta')

      const somaDiretaRecuperada = Number(stats.directValueCents) + Number(stats.recoveredValueCents)
      assert.equal(somaDiretaRecuperada, Number(stats.aprovadaValueCents), 'direta + recuperada = total de vendas aprovadas do periodo')
    })

    await test('infoproduto: evento de checkout conta mesmo sem first_contact_at (webhook de pagamento nao e conversa)', async () => {
      // Bug real encontrado em producao (Isabela Fanini, company_id=2): TODAS
      // as linhas de compra_aprovada tinham first_contact_at nulo porque esse
      // campo so e preenchido por markLeadContacted (mensagem de WhatsApp/
      // Instagram), nunca pelos webhooks de checkout. O funil de checkout
      // inteiro (boleto/pix/carrinho/cartao/aprovada) e a divisao
      // direta/recuperada ficavam ZERADOS mesmo com venda real aprovada.
      // platform: 'hotmart' em toda linha de proposito: recovery_leads_chat_
      // company_phone_unique so permite UM lead por (company_id, phone) para
      // platform in ('instagram','sac','hermes'), e o telefone 606 abaixo
      // precisa de duas linhas (abandono + aprovada), exatamente como um
      // webhook de venda de verdade grava (ver recovery_leads_txn_dedup_unique).
      await testDb.insert(schema.recoveryLeads).values([
        lead(12, '601', { platform: 'hotmart', eventType: 'boleto', firstContactAt: null, productValue: 3000 }),
        lead(12, '602', { platform: 'hotmart', eventType: 'pix', firstContactAt: null, productValue: 4000 }),
        lead(12, '603', { platform: 'hotmart', eventType: 'carrinho_abandonado', firstContactAt: null, productValue: 5000 }),
        lead(12, '604', { platform: 'hotmart', eventType: 'cartao_recusado', firstContactAt: null, productValue: 6000 }),
        // Venda direta real, nunca contatada por mensagem alguma.
        lead(12, '605', { platform: 'hotmart', eventType: 'compra_aprovada', status: 'completed', firstContactAt: null, productValue: 7000 }),
        // Venda recuperada: abandono convertido por mensagem, mas o PROPRIO
        // registro de abandono tambem nunca teve first_contact_at preenchido.
        lead(12, '606', {
          platform: 'hotmart',
          eventType: 'carrinho_abandonado',
          status: 'converted',
          convertedFrom: 'msg_1',
          firstContactAt: null,
          productValue: 8000,
        }),
        lead(12, '606', { platform: 'hotmart', eventType: 'compra_aprovada', status: 'completed', firstContactAt: null, productValue: 8000 }),
      ])

      const [stats] = await testDb
        .select(dashboardLeadStatsSelect('infoproduto'))
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 12))

      assert.equal(stats.boleto, 1)
      assert.equal(stats.pix, 1)
      assert.equal(stats.carrinho, 2, '603 (pendente) + 606 (convertido)')
      assert.equal(stats.cartao, 1)
      assert.equal(stats.aprovada, 2, '605 (direta) + 606 (recuperada)')
      assert.equal(Number(stats.aprovadaValueCents), 15000, '7000 + 8000')

      assert.equal(stats.directCount, 1)
      assert.equal(Number(stats.directValueCents), 7000)
      assert.equal(stats.recoveredCount, 1)
      assert.equal(Number(stats.recoveredValueCents), 8000)
    })

    await test('infoproduto: "Leads Totais" e "fechadosTotal" tambem nao podem depender de first_contact_at (o fix acima so cobre o funil de checkout)', async () => {
      // O fix de boleto/pix/carrinho/cartao/aprovada acima nao mexe em
      // `total`/`aguardandoAbordagem`/`respondeuTotal`/`avancouTotal`: sao
      // campos do funil de CONVERSA, que continuam corretos pra gramado/
      // lucas/agencia. Mas pra infoproduto "total" e o KPI "Leads Totais" do
      // dashboard, e ele tambem exigia first_contact_at is not null, entao
      // ficava zerado pelo MESMO motivo (webhook de checkout nunca chama
      // markLeadContacted). Reproduz o cenario real da Isabela Fanini
      // (company_id=2): 100% dos leads do periodo sem first_contact_at.
      await testDb.insert(schema.recoveryLeads).values([
        lead(13, '701', { platform: 'hotmart', status: 'completed', eventType: 'compra_aprovada', firstContactAt: null, productValue: 43604 }),
        lead(13, '702', { platform: 'hotmart', status: 'completed', eventType: 'compra_aprovada', firstContactAt: null, productValue: 19700 }),
        lead(13, '703', { platform: 'kiwify', status: 'pending', eventType: 'carrinho_abandonado', firstContactAt: null }),
        lead(13, '704', { platform: 'kiwify', status: 'pending', eventType: 'carrinho_abandonado', firstContactAt: null }),
        lead(13, '705', { platform: 'greenn', status: 'pending', eventType: 'pix', firstContactAt: null, productValue: 11400 }),
        lead(13, '706', { platform: 'zouti', status: 'pending', eventType: 'boleto', firstContactAt: null }),
        // Um lead que POR ACASO foi contatado (ex.: sequencia de recuperacao
        // ativa que rodou): deve continuar contando tambem, sem duplicar.
        lead(13, '707', { platform: 'hotmart', status: 'pending', eventType: 'cartao_recusado', firstContactAt: NOW }),
      ])

      const [stats] = await testDb
        .select(dashboardLeadStatsSelect('infoproduto'))
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 13))

      assert.equal(stats.total, 7, '"Leads Totais" conta TODO evento de checkout, contatado ou nao')
      assert.equal(stats.fechadosTotal, 2, 'compra_aprovada conta como negocio ganho independente de contato')

      // Contraste de controle: o MESMO gate continua valendo para modelos
      // conversacionais (gramado/lucas/agencia), onde "abordado de verdade"
      // ainda e a regra certa. Reaproveita os leads da empresa 7 (agencia)
      // que ja tem 1 lead sem first_contact_at (407): ele TEM que continuar
      // fora do total, senao a mudanca acima regrediu pra outro modelo.
      const [agenciaStats] = await testDb
        .select(dashboardLeadStatsSelect('agencia'))
        .from(schema.recoveryLeads)
        .where(eq(schema.recoveryLeads.companyId, 7))
      assert.equal(agenciaStats.total, 6, 'agencia continua exigindo first_contact_at (nao regrediu)')
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
