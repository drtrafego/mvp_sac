// Teste: a pausa do bot (lead, canal, geral e a chave company_pause_switches)
// bloqueia o bot CONVERSACIONAL e NÃO bloqueia mensagem de evento transacional
// do checkout (compra, boleto, Pix, cartão recusado, funil pós-compra).
//
// Incidente de origem: a correção da chave de pausa fazia "pausa ligada"
// cancelar jobs do cron e nascer lead pausado. O bot da Isabela só dispara
// eventos da Kiwify e o "Pausar tudo" fica ligado de propósito para a IA não
// conversar. O disparo de evento não pode ser cancelado por isso.
//
// PGlite real + rota do cron e rota do webhook da Kiwify rodando de verdade.
// Mocks: '@/lib/db' (PGlite), '@/lib/cron-advisory-lock', '@/lib/whatsapp'
// (espião do transporte), '@/lib/leads', '@/lib/sac-pending-rules'.
//
// Uso: npm run test:bot-pause-transactional

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { createSacTestDatabase } from './sac-test-pglite'

process.env.CRON_SECRET = 'cron-local'
process.env.SAC_WEBHOOK_SECRET = 'webhook-local'
process.env.SKIP_DISPATCH_SPACING = '1'

type Sent = { phone: string; templateName?: string; type: string }

async function main() {
  const fixture = await createSacTestDatabase([
    schema.companies, schema.settings, schema.recoveryLeads, schema.messageJobs,
    schema.sequenceMessages, schema.recoverySequences, schema.whatsappMessages,
    schema.massDispatchPhoneCooldowns, schema.agendaBlockedDates, schema.nativeAvailabilitySchedules,
    schema.companyPauseSwitches, schema.sacAuditEvents, schema.metaMessageTemplates,
    schema.webhookReceived, schema.massDispatchBatches,
  ])
  const { db, pg } = fixture
  const sent: Sent[] = []

  mock.method(globalThis, 'fetch', async () => { throw new Error('Rede proibida no teste') })
  mock.module('@/lib/db', { namedExports: { db } })
  mock.module('@/lib/cron-advisory-lock', {
    namedExports: { tryAcquireCronDispatchLock: async () => ({}), releaseCronDispatchLock: async () => undefined },
  })
  mock.module('@/lib/whatsapp', {
    namedExports: {
      sendWhatsAppMessage: async (phone: string, msg: { type: string; templateName?: string }) => {
        sent.push({ phone, type: msg.type, templateName: msg.templateName })
        return `wamid.${sent.length}`
      },
      formatBrazilianPhone: (raw: string) => raw.replace(/\D/g, ''),
    },
  })
  mock.module('@/lib/leads', { namedExports: { markLeadContacted: async () => undefined } })
  mock.module('@/lib/sac-pending-rules', { namedExports: { evaluateSacPendingRules: async () => ({}) } })

  const cron = await import('../src/app/api/cron/route')
  const kiwify = await import('../src/app/api/webhooks/kiwify/[slug]/route')
  const { setPauseSwitch } = await import('../src/lib/bot-pause')
  const {
    classifyMessageJob, pauseAppliesToJob, isOptOutPause,
    TRANSACTIONAL_JOB_TYPES, CONVERSATIONAL_JOB_TYPES,
  } = await import('../src/lib/message-job-class')
  const { PIX_FOLLOWUP_JOB_TYPE } = await import('../src/lib/pix-followup-policy')
  const { ISABELA_BOLETO_JOB_TYPE, ISABELA_FLOW_JOB_TYPES } = await import('../src/lib/recovery-sequence-policy')

  const generic = { id: 1, name: 'Empresa Generica', slug: 'empresa-generica' }
  const isabela = { id: 2, name: 'Isabela', slug: 'isabela-fanini' }
  const PAST = new Date(Date.now() - 60_000)

  const runCron = async () => {
    const res = await cron.POST(new NextRequest('http://localhost/api/cron', {
      method: 'POST', headers: { Authorization: 'Bearer cron-local' },
    }))
    return res.json() as Promise<{ processed: number; sent: number; failed: number }>
  }
  const jobById = async (id: number) => (await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.id, id)))[0]
  const reset = async () => {
    await pg.exec('TRUNCATE recovery_leads, message_jobs, whatsapp_messages, company_pause_switches, sac_audit_events, webhook_received RESTART IDENTITY')
    sent.length = 0
  }
  let phoneSeq = 5551990000000
  const newLead = async (companyId: number, values: Partial<typeof schema.recoveryLeads.$inferInsert> = {}) => {
    const [lead] = await db.insert(schema.recoveryLeads).values({
      companyId, platform: 'kiwify', eventType: 'boleto', phone: String(++phoneSeq), name: 'Cliente Teste',
      productName: 'Produto', status: 'pending', channel: 'whatsapp', whatsappConsentStatus: 'opted_in',
      transactionId: `tx-${phoneSeq}`, ...values,
    }).returning()
    return lead
  }
  const newMessage = async (sequenceId: number, templateName: string | null) => {
    const [m] = await db.insert(schema.sequenceMessages).values({
      sequenceId, order: 1, delayMinutes: 0, messageType: templateName ? 'template' : 'text',
      content: 'Olá {nome}', templateName, templateLanguage: templateName ? 'pt_BR' : null, isActive: true,
    }).returning()
    return m
  }
  const newJob = async (leadId: number, messageId: number | null, values: Partial<typeof schema.messageJobs.$inferInsert> = {}) => {
    const [job] = await db.insert(schema.messageJobs).values({
      leadId, messageId, scheduledFor: PAST, status: 'pending', checkBeforeSend: false, ...values,
    }).returning()
    return job
  }

  try {
    await db.insert(schema.companies).values([generic, isabela])
    for (const c of [generic, isabela]) {
      // Janela de atendimento aberta 24h: o teste é da PAUSA, não da janela comercial de follow-up
      // (que atrasa qualquer job com messageOrder fora de 08h-12h; ver relatório do dev).
      const openAllDay = [{ inicio: '00:00', fim: '23:59' }]
      await db.insert(schema.settings).values({
        companyId: c.id, whatsappProvider: 'meta', metaPhoneNumberId: `phone-${c.id}`, metaAccessToken: 'tok',
        availabilityScheduleManual: true,
        availabilitySchedule: {
          segunda: openAllDay, terca: openAllDay, quarta: openAllDay, quinta: openAllDay, sexta: openAllDay,
          sabado: openAllDay, domingo: openAllDay, timezone: 'America/Sao_Paulo', duracaoSlotMinutos: 30,
        },
      })
    }
    const [genericSeq] = await db.insert(schema.recoverySequences).values({ companyId: generic.id, eventType: 'boleto', name: 'Boleto', isActive: true }).returning()
    const [isabelaSeq] = await db.insert(schema.recoverySequences).values({ companyId: isabela.id, eventType: 'compra_aprovada', name: 'Funil', isActive: true }).returning()
    const genericMsg = await newMessage(genericSeq.id, 'boleto_generico')
    const welcomeMsg = await newMessage(isabelaSeq.id, 'boas_vindas_despertar_pos_compra')
    const pixMsg = await newMessage(isabelaSeq.id, 'pix_despertar_nao_pago')
    await db.update(schema.sequenceMessages).set({ delayMinutes: 60 }).where(eq(schema.sequenceMessages.id, pixMsg.id))
    for (const [name, category] of [['boas_vindas_despertar_pos_compra', 'MARKETING'], ['pix_despertar_nao_pago', 'UTILITY'], ['convite_portal_apos_desafio', 'MARKETING']] as const) {
      await db.insert(schema.metaMessageTemplates).values({ companyId: isabela.id, name, language: 'pt_BR', status: 'APPROVED', category, components: [{ type: 'BODY', text: 'Olá {{1}}' }] })
    }
    const portalMsg = await newMessage(isabelaSeq.id, 'convite_portal_apos_desafio')

    await test('classificação: todos os tipos de job do cron têm classe definida e as constantes batem', () => {
      assert.ok(TRANSACTIONAL_JOB_TYPES.has(PIX_FOLLOWUP_JOB_TYPE))
      assert.ok(TRANSACTIONAL_JOB_TYPES.has(ISABELA_BOLETO_JOB_TYPE))
      // Todo jobType do fluxo Isabela está classificado (transacional ou conversacional): nenhum cai no padrão por esquecimento.
      for (const t of ISABELA_FLOW_JOB_TYPES) assert.ok(TRANSACTIONAL_JOB_TYPES.has(t) || CONVERSATIONAL_JOB_TYPES.has(t), `jobType ${t} sem classe`)
      const kiwifyBoleto = { platform: 'kiwify', eventType: 'boleto' }
      for (const t of ['isabela_purchase_sequence', ISABELA_BOLETO_JOB_TYPE, 'isabela_cartao_recusado', PIX_FOLLOWUP_JOB_TYPE]) {
        assert.equal(classifyMessageJob({ jobType: t }, kiwifyBoleto), 'transactional', t)
      }
      assert.equal(classifyMessageJob({ jobType: 'isabela_portal_after_challenge' }, kiwifyBoleto), 'conversational')
      // Sequência de webhook de checkout sem jobType: transacional (Kiwify/Hotmart/Greenn/Zouti).
      for (const platform of ['kiwify', 'hotmart', 'greenn', 'zouti']) {
        for (const eventType of ['compra_aprovada', 'boleto', 'pix', 'cartao_recusado', 'carrinho_abandonado']) {
          assert.equal(classifyMessageJob({ jobType: null }, { platform, eventType }), 'transactional', `${platform}/${eventType}`)
        }
      }
      // Upsell, lote em massa e lead manual/importado: promocional (bloqueado). Dúvida => bloqueia.
      assert.equal(classifyMessageJob({ jobType: null, upsellContent: 'Oferta' }, kiwifyBoleto), 'promotional')
      assert.equal(classifyMessageJob({ jobType: null, massDispatchBatchId: 9 }, kiwifyBoleto), 'promotional')
      assert.equal(classifyMessageJob({ jobType: 'isabela_purchase_sequence', massDispatchBatchId: 9 }, kiwifyBoleto), 'promotional')
      assert.equal(classifyMessageJob({ jobType: null }, { platform: 'import_planilha', eventType: 'atendimento' }), 'promotional')
      assert.equal(classifyMessageJob({ jobType: null }, { platform: 'sac', eventType: 'atendimento' }), 'promotional')
      assert.equal(classifyMessageJob({ jobType: 'tipo_desconhecido' }, kiwifyBoleto), 'promotional')
      assert.equal(classifyMessageJob({ jobType: null }, { platform: 'kiwify', eventType: 'disputa' }), 'promotional')
      assert.equal(pauseAppliesToJob('transactional'), false)
      assert.equal(pauseAppliesToJob('conversational'), true)
      assert.equal(pauseAppliesToJob('promotional'), true)
      assert.equal(isOptOutPause({ botPaused: true, botPausedBy: 'optout_whatsapp' }), true)
      assert.equal(isOptOutPause({ botPaused: true, botPausedBy: 'revisao_possivel_optout' }), true)
      assert.equal(isOptOutPause({ botPaused: true, botPausedBy: 'Administrador (Agente IA)' }), false)
      assert.equal(isOptOutPause({ botPaused: false, botPausedBy: 'optout_whatsapp' }), false)
    })

    await test('chave GERAL ligada: funil pós-compra Kiwify da Isabela e boleto de checkout são ENVIADOS; follow-up, portal, upsell e lote são BLOQUEADOS', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'teste' })
      await setPauseSwitch({ companyId: generic.id, scope: 'all', active: true, by: 'teste' })

      const funnelLead = await newLead(isabela.id, { eventType: 'compra_aprovada', botPaused: true, botPausedBy: 'auto (pausa geral ativa)', botPausedAll: true })
      const funnelJob = await newJob(funnelLead.id, welcomeMsg.id, { jobType: 'isabela_purchase_sequence', idempotencyKey: 'k1' })

      const boletoLead = await newLead(generic.id, { eventType: 'boleto', botPaused: true, botPausedBy: 'auto (pausa geral ativa)', botPausedAll: true })
      const boletoJob = await newJob(boletoLead.id, genericMsg.id)

      // Mesmo lead de compra: sequência de evento (transacional) + upsell (promocional).
      const buyLead = await newLead(generic.id, { eventType: 'compra_aprovada', botPaused: true })
      const buySeqJob = await newJob(buyLead.id, genericMsg.id)
      const upsellJob = await newJob(buyLead.id, null, { upsellContent: 'Oferta especial {nome}' })

      const portalLead = await newLead(isabela.id, { eventType: 'compra_aprovada' })
      const portalJob = await newJob(portalLead.id, portalMsg.id, { jobType: 'isabela_portal_after_challenge', idempotencyKey: 'k2' })

      const manualLead = await newLead(generic.id, { platform: 'import_planilha', eventType: 'atendimento' })
      const manualJob = await newJob(manualLead.id, genericMsg.id)

      const massLead = await newLead(generic.id, { platform: 'import_planilha', eventType: 'import_planilha' })
      const [batch] = await db.insert(schema.massDispatchBatches).values({ companyId: generic.id, fileName: 'x.csv', eventType: 'import_planilha', status: 'sending' } as never).returning()
      const massJob = await newJob(massLead.id, null, {
        massDispatchBatchId: batch.id,
        messageSnapshot: { messageType: 'template', content: 'Oi', templateName: 'campanha', templateLanguage: 'pt_BR' },
      })

      const result = await runCron()
      assert.equal(result.sent, 3, JSON.stringify({ result, sent }))
      assert.equal((await jobById(funnelJob.id)).status, 'sent', 'funil pós-compra Kiwify tem que sair')
      assert.equal((await jobById(boletoJob.id)).status, 'sent', 'boleto de checkout tem que sair')
      assert.equal((await jobById(buySeqJob.id)).status, 'sent', 'sequência de evento da compra tem que sair')
      assert.equal((await jobById(upsellJob.id)).status, 'cancelled', 'upsell promocional é bloqueado')
      assert.match((await jobById(upsellJob.id)).error ?? '', /Pausa da empresa|bot pausado/)
      for (const blocked of [portalJob, manualJob, massJob]) assert.equal((await jobById(blocked.id)).status, 'cancelled', `job ${blocked.id} deveria ser bloqueado`)
      assert.ok(sent.some(s => s.templateName === 'boas_vindas_despertar_pos_compra'))
      assert.equal(sent.some(s => s.templateName === 'campanha' || s.templateName === 'convite_portal_apos_desafio'), false)
      // Upsell cancelado NÃO derruba o transacional irmão do mesmo lead (buySeqJob acima).
    })

    await test('Pix pendente (pix_followup_60m) sai com a chave geral ligada e com lead pausado', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'teste' })
      const lead = await newLead(isabela.id, {
        eventType: 'pix', paymentType: 'pix', pixCode: 'copia-e-cola', pixExpiry: new Date(Date.now() + 3600_000),
        botPaused: true, botPausedBy: 'Administrador (Agente IA)', botPausedAll: true,
      })
      const job = await newJob(lead.id, pixMsg.id, { jobType: 'pix_followup_60m', checkBeforeSend: true, idempotencyKey: 'pix-1' })
      const result = await runCron()
      assert.equal(result.sent, 1, JSON.stringify({ result, job: await jobById(job.id) }))
      assert.equal((await jobById(job.id)).status, 'sent')
      assert.deepEqual(sent.map(s => s.templateName), ['pix_despertar_nao_pago'])
    })

    await test('lead.botPaused=true sem chave nenhuma: transacional sai, follow-up promocional não', async () => {
      await reset()
      const txLead = await newLead(generic.id, { eventType: 'boleto', botPaused: true, botPausedBy: 'Atendente' })
      const txJob = await newJob(txLead.id, genericMsg.id)
      const foLead = await newLead(generic.id, { platform: 'import_planilha', eventType: 'atendimento', botPaused: true, botPausedBy: 'Atendente' })
      const foJob = await newJob(foLead.id, genericMsg.id)
      await runCron()
      assert.equal((await jobById(txJob.id)).status, 'sent')
      assert.equal((await jobById(foJob.id)).status, 'cancelled')
      assert.equal((await jobById(foJob.id)).error, 'Lead com bot pausado antes do envio')
    })

    await test('chave só do canal WhatsApp ligada: transacional sai; chave do Instagram não afeta follow-up WhatsApp', async () => {
      await reset()
      await setPauseSwitch({ companyId: generic.id, scope: 'whatsapp', active: true, by: 'teste' })
      const txLead = await newLead(generic.id, { eventType: 'pix' })
      const txJob = await newJob(txLead.id, genericMsg.id)
      const foLead = await newLead(generic.id, { platform: 'import_planilha', eventType: 'atendimento' })
      const foJob = await newJob(foLead.id, genericMsg.id)
      await runCron()
      assert.equal((await jobById(txJob.id)).status, 'sent')
      assert.equal((await jobById(foJob.id)).status, 'cancelled')
      await reset()
      await setPauseSwitch({ companyId: generic.id, scope: 'instagram', active: true, by: 'teste' })
      const foLead2 = await newLead(generic.id, { platform: 'import_planilha', eventType: 'atendimento' })
      const foJob2 = await newJob(foLead2.id, genericMsg.id)
      await runCron()
      assert.equal((await jobById(foJob2.id)).status, 'sent', 'chave de outro canal não bloqueia o WhatsApp')
    })

    await test('opt-out continua bloqueando o transacional (pausa por pedido de parar, consentimento opted_out)', async () => {
      await reset()
      const l1 = await newLead(generic.id, { eventType: 'boleto', botPaused: true, botPausedBy: 'optout_whatsapp', whatsappConsentStatus: 'opted_out' })
      const j1 = await newJob(l1.id, genericMsg.id)
      const l2 = await newLead(generic.id, { eventType: 'boleto', botPaused: true, botPausedBy: 'revisao_possivel_optout' })
      const j2 = await newJob(l2.id, genericMsg.id)
      const l3 = await newLead(generic.id, { eventType: 'boleto', whatsappConsentStatus: 'opted_out' })
      const j3 = await newJob(l3.id, genericMsg.id)
      const result = await runCron()
      assert.equal(result.sent, 0, JSON.stringify(sent))
      for (const j of [j1, j2, j3]) assert.equal((await jobById(j.id)).status, 'cancelled')
      assert.equal(sent.length, 0)
    })

    await test('Isabela sem opt-in explícito continua sem receber funil (consentimento não é pausa)', async () => {
      await reset()
      const lead = await newLead(isabela.id, { eventType: 'compra_aprovada', whatsappConsentStatus: 'unknown' })
      const job = await newJob(lead.id, welcomeMsg.id, { jobType: 'isabela_purchase_sequence', idempotencyKey: 'k-consent' })
      await runCron()
      assert.equal((await jobById(job.id)).status, 'cancelled')
      assert.equal(sent.length, 0)
    })

    await test('ponta a ponta: webhook Kiwify com a chave geral ligada cria lead (nasce pausado para a IA), agenda o job e o cron ENVIA', async () => {
      await reset()
      await setPauseSwitch({ companyId: generic.id, scope: 'all', active: true, by: 'teste' })
      const payload = {
        webhook_event_type: 'billet_created', order_id: 'ORDER-E2E-1', order_status: 'waiting_payment', payment_method: 'boleto',
        boleto_URL: 'https://boleto.exemplo/1', boleto_barcode: '123456789', boleto_expiry_date: '30/12/2030',
        created_at: '2026-11-11 10:00',
        Product: { product_id: 'p1', product_name: 'Produto E2E' },
        Customer: { full_name: 'Cliente E2E', mobile: '+55 51 99999-1234', email: 'e2e@exemplo.test' },
        Commissions: { charge_amount: 9700 },
      }
      const res = await kiwify.POST(
        new NextRequest(`http://localhost/api/webhooks/kiwify/${generic.slug}?token=webhook-local`, { method: 'POST', body: JSON.stringify(payload) }),
        { params: Promise.resolve({ slug: generic.slug }) },
      )
      assert.equal(res.status, 200, await res.clone().text())
      const [lead] = await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.transactionId, 'ORDER-E2E-1'))
      assert.ok(lead, 'lead criado pelo webhook')
      assert.equal(lead.botPaused, true, 'a IA não conversa com lead criado sob a chave')
      assert.equal(lead.platform, 'kiwify')
      const jobs = await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.leadId, lead.id))
      assert.equal(jobs.length, 1, 'o job de evento é agendado mesmo com a chave ligada')
      // Libera o atraso mínimo de 30 min do primeiro passo de recuperação.
      await db.update(schema.messageJobs).set({ scheduledFor: PAST }).where(eq(schema.messageJobs.id, jobs[0].id))
      const result = await runCron()
      assert.equal(result.sent, 1, JSON.stringify({ result, job: await jobById(jobs[0].id) }))
      assert.equal((await jobById(jobs[0].id)).status, 'sent')
      assert.equal(sent[0].phone, lead.phone)
    })
  } finally {
    await fixture.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
