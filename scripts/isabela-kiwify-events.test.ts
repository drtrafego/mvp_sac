// Teste: eventos da Kiwify da Isabela (compra aprovada, boleto, Pix, cartão recusado)
// disparam os templates certos, com os parâmetros certos, SEM exigir opt_in
// (decisão do Gastão, 12/11/2026), com a pausa geral "all" ligada, sem nada
// retroativo e sem afetar outras empresas.
//
// PGlite real + webhook da Kiwify e cron rodando de verdade. Payloads seguem o
// formato documentado da Kiwify (dados anonimizados). Rede proibida: o
// transporte da Meta é um espião.
//
// Uso: node --experimental-test-module-mocks --import tsx --test scripts/isabela-kiwify-events.test.ts

import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { NextRequest } from 'next/server'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { createSacTestDatabase } from './sac-test-pglite'

process.env.CRON_SECRET = 'cron-local'
process.env.SAC_WEBHOOK_SECRET = 'webhook-local'
process.env.SKIP_DISPATCH_SPACING = '1'

type SentMessage = {
  phone: string
  type: string
  templateName?: string
  templateLanguage?: string
  templateVariableNames?: string[]
  templateVariableValues?: string[]
}

const nowSp = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).slice(0, 16)
const ORDER_ID = (n: number) => `0a1b2c3d-0000-4000-8000-${String(n).padStart(12, '0')}`

async function main() {
  const fixture = await createSacTestDatabase([
    schema.companies, schema.settings, schema.recoveryLeads, schema.messageJobs,
    schema.sequenceMessages, schema.recoverySequences, schema.whatsappMessages,
    schema.massDispatchPhoneCooldowns, schema.agendaBlockedDates, schema.nativeAvailabilitySchedules,
    schema.companyPauseSwitches, schema.sacAuditEvents, schema.metaMessageTemplates,
    schema.webhookReceived, schema.massDispatchBatches,
  ])
  const { db, pg } = fixture
  const sent: SentMessage[] = []

  mock.method(globalThis, 'fetch', async () => { throw new Error('Rede proibida no teste') })
  mock.module('@/lib/db', { namedExports: { db } })
  mock.module('@/lib/cron-advisory-lock', {
    namedExports: { tryAcquireCronDispatchLock: async () => ({}), releaseCronDispatchLock: async () => undefined },
  })
  mock.module('@/lib/whatsapp', {
    namedExports: {
      sendWhatsAppMessage: async (phone: string, msg: SentMessage) => {
        sent.push({
          phone, type: msg.type, templateName: msg.templateName, templateLanguage: msg.templateLanguage,
          templateVariableNames: msg.templateVariableNames, templateVariableValues: msg.templateVariableValues,
        })
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

  const generic = { id: 1, name: 'Empresa Generica', slug: 'empresa-generica' }
  const isabela = { id: 2, name: 'Isabela', slug: 'isabela-fanini' }

  const runCron = async () => {
    const res = await cron.POST(new NextRequest('http://localhost/api/cron', {
      method: 'POST', headers: { Authorization: 'Bearer cron-local' },
    }))
    return res.json() as Promise<{ processed: number; sent: number; failed: number }>
  }
  const postKiwify = async (slug: string, payload: Record<string, unknown>) => {
    const res = await kiwify.POST(
      new NextRequest(`http://localhost/api/webhooks/kiwify/${slug}?token=webhook-local`, { method: 'POST', body: JSON.stringify(payload) }),
      { params: Promise.resolve({ slug }) },
    )
    assert.equal(res.status, 200, await res.clone().text())
  }
  const reset = async () => {
    await pg.exec('TRUNCATE recovery_leads, message_jobs, whatsapp_messages, sac_audit_events, webhook_received RESTART IDENTITY')
    sent.length = 0
  }
  const jobsOf = async (transactionId: string) => {
    const leads = await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.transactionId, transactionId))
    const out: (typeof schema.messageJobs.$inferSelect)[] = []
    for (const lead of leads) out.push(...await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.leadId, lead.id)))
    return out
  }
  const lastParams = (message: SentMessage) => Object.fromEntries((message.templateVariableNames ?? []).map((name, i) => [name, message.templateVariableValues?.[i]]))
  const releaseAll = () => db.update(schema.messageJobs).set({ scheduledFor: new Date(Date.now() - 60_000) })
  const lastWebhookSkip = async () => (await db.select().from(schema.webhookReceived)).map(row => row.skipReason)

  const customer = (mobile: string, extra: Record<string, unknown> = {}) => ({
    full_name: 'MARIA DA SILVA SANTOS', first_name: 'MARIA', email: 'cliente@exemplo.test', mobile, ...extra,
  })
  const base = (n: number, extra: Record<string, unknown>) => ({
    order_id: ORDER_ID(n), order_ref: `Ab${n}Cd7E`, created_at: nowSp(),
    Product: { product_id: 'prod-despertar', product_name: 'Despertar das Bellas' },
    Commissions: { charge_amount: 9700 }, ...extra,
  })

  try {
    await db.insert(schema.companies).values([generic, isabela])
    const openAllDay = [{ inicio: '00:00', fim: '23:59' }]
    for (const c of [generic, isabela]) {
      await db.insert(schema.settings).values({
        companyId: c.id, whatsappProvider: 'meta', metaPhoneNumberId: `phone-${c.id}`, metaAccessToken: 'tok',
        availabilityScheduleManual: true,
        availabilitySchedule: {
          segunda: openAllDay, terca: openAllDay, quarta: openAllDay, quinta: openAllDay, sexta: openAllDay,
          sabado: openAllDay, domingo: openAllDay, timezone: 'America/Sao_Paulo', duracaoSlotMinutos: 30,
        },
      })
    }

    // Templates como estão na Meta em 12/11/2026 (nomes, categorias e corpos conferidos por readback).
    const metaTemplates: [string, string, string, string[]][] = [
      ['boas_vindas_despertar_pos_compra', 'MARKETING', 'Olá, {{customer_name}}! Sua compra do Despertar das Bellas foi aprovada.', ['customer_name']],
      ['formulario_desafio_d1', 'MARKETING', 'Olá, {{customer_name}}! Por ter adquirido o Despertar das Bellas, você está concorrendo a uma sessão.', ['customer_name']],
      ['acompanhamento_desafio_d10', 'UTILITY', 'Olá, {{customer_name}}! Já se passaram dez dias desde a sua compra.', ['customer_name']],
      ['boleto_despertar_nao_pago', 'UTILITY', 'Olá, {{customer_name}}! O pagamento por boleto da compra {{order_reference}} ainda não foi identificado. O vencimento informado é {{payment_due_date}}.', ['customer_name', 'order_reference', 'payment_due_date']],
      ['pix_despertar_nao_pago', 'UTILITY', 'Olá, {{customer_name}}! O pagamento via Pix da compra {{order_reference}} ainda não foi identificado. O código Pix fica disponível até {{pix_expiry}}.', ['customer_name', 'order_reference', 'pix_expiry']],
      ['cartao_despertar_recusado', 'UTILITY', 'Olá, {{customer_name}}! O pagamento com cartão da compra {{order_reference}} não foi aprovado.', ['customer_name', 'order_reference']],
      ['convite_portal_apos_desafio', 'MARKETING', 'Convite do Portal para {{customer_name}}', ['customer_name']],
    ]
    for (const [name, category, text, params] of metaTemplates) {
      await db.insert(schema.metaMessageTemplates).values({
        companyId: isabela.id, name, language: 'pt_BR', status: 'APPROVED', category,
        components: [{ type: 'BODY', text, example: { body_text_named_params: params.map(param_name => ({ param_name, example: 'x' })) } }],
      })
    }

    const seq = async (eventType: string) => (await db.insert(schema.recoverySequences).values({ companyId: isabela.id, eventType, name: eventType, isActive: true }).returning())[0]
    const msg = async (sequenceId: number, order: number, templateName: string, delayMinutes: number, map: Record<string, string>) => {
      await db.insert(schema.sequenceMessages).values({
        sequenceId, order, delayMinutes, messageType: 'template', templateName, templateLanguage: 'pt_BR', templateVariablesMap: map, isActive: true,
      })
    }
    const compra = await seq('compra_aprovada')
    await msg(compra.id, 1, 'boas_vindas_despertar_pos_compra', 0, { customer_name: '{nome}' })
    await msg(compra.id, 2, 'formulario_desafio_d1', 1440, { customer_name: '{nome}' })
    await msg(compra.id, 3, 'acompanhamento_desafio_d10', 14400, { customer_name: '{nome}' })
    const boleto = await seq('boleto')
    await msg(boleto.id, 1, 'boleto_despertar_nao_pago', 0, { customer_name: '{nome}', order_reference: '{transacao}', payment_due_date: '{boleto_validade}' })
    const pix = await seq('pix')
    await msg(pix.id, 1, 'pix_despertar_nao_pago', 60, { customer_name: '{nome}', order_reference: '{transacao}', pix_expiry: '{pix_validade}' })
    const cartao = await seq('cartao_recusado')
    await msg(cartao.id, 1, 'cartao_despertar_recusado', 30, { customer_name: '{nome}', order_reference: '{transacao}' })

    // Produção real: a pausa geral fica LIGADA; só o bypass transacional passa.
    await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'teste' })

    await test('compra aprovada sem opt_in: agenda os 3 templates nomeados e o cron envia o 1º com primeiro nome', async () => {
      await reset()
      await postKiwify(isabela.slug, base(1, {
        webhook_event_type: 'order_approved', order_status: 'paid', payment_method: 'credit_card',
        approved_date: nowSp(), Customer: customer('+55 65 99999-0001'),
      }))
      const jobs = (await jobsOf(ORDER_ID(1))).sort((a, b) => (a.messageOrder ?? 0) - (b.messageOrder ?? 0))
      assert.equal(jobs.length, 3, JSON.stringify(await lastWebhookSkip()))
      assert.ok(jobs.every(job => job.jobType === 'isabela_purchase_sequence'))
      const [lead] = await db.select().from(schema.recoveryLeads)
      assert.equal(lead.whatsappConsentStatus, 'unknown', 'sem opt_in no payload: continua unknown, não foi alterado')
      assert.equal(lead.botPaused, true, 'IA não conversa: lead nasce sob a pausa geral')
      await releaseAll()
      const result = await runCron()
      assert.equal(result.sent, 1, JSON.stringify({ result, sent }))
      assert.deepEqual(sent[0], {
        phone: '5565999990001', type: 'template', templateName: 'boas_vindas_despertar_pos_compra', templateLanguage: 'pt_BR',
        templateVariableNames: ['customer_name'], templateVariableValues: ['Maria'],
      })
      const [history] = await db.select().from(schema.whatsappMessages)
      assert.match(history.content ?? '', /Olá, Maria! Sua compra/)
      assert.doesNotMatch(history.content ?? '', /SILVA|\[nome|\{\{/)
    })

    await test('boleto sem opt_in: customer_name, order_reference curto (order_ref) e vencimento no fuso de São Paulo', async () => {
      await reset()
      await postKiwify(isabela.slug, base(2, {
        webhook_event_type: 'billet_created', order_status: 'waiting_payment', payment_method: 'boleto',
        boleto_URL: 'https://boleto.exemplo/2', boleto_barcode: '34191790010104351004791020150008184480026000',
        boleto_expiry_date: '31/12/2030', Customer: customer('+55 65 99999-0002'),
      }))
      const jobs = await jobsOf(ORDER_ID(2))
      assert.equal(jobs.length, 1, JSON.stringify(await lastWebhookSkip()))
      assert.equal(jobs[0].jobType, 'boleto_followup_immediate')
      await releaseAll()
      assert.equal((await runCron()).sent, 1, JSON.stringify(sent))
      assert.deepEqual(lastParams(sent[0]), { customer_name: 'Maria', order_reference: 'Ab2Cd7E', payment_due_date: '31/12/2030' })
    })

    await test('cartão recusado sem opt_in: envia customer_name e order_reference curto', async () => {
      await reset()
      await postKiwify(isabela.slug, base(3, {
        webhook_event_type: 'order_rejected', order_status: 'refused', payment_method: 'credit_card',
        card_rejection_reason: 'insufficient_funds', Customer: customer('+55 65 99999-0003'),
      }))
      const jobs = await jobsOf(ORDER_ID(3))
      assert.equal(jobs.length, 1, JSON.stringify(await lastWebhookSkip()))
      assert.equal(jobs[0].jobType, 'isabela_cartao_recusado')
      await releaseAll()
      assert.equal((await runCron()).sent, 1, JSON.stringify(sent))
      assert.equal(sent[0].templateName, 'cartao_despertar_recusado')
      assert.deepEqual(lastParams(sent[0]), { customer_name: 'Maria', order_reference: 'Ab3Cd7E' })
    })

    await test('Pix sem opt_in: o webhook agenda o follow-up de 60 min (antes nunca agendava) e o cron envia com a validade', async () => {
      await reset()
      await postKiwify(isabela.slug, base(4, {
        webhook_event_type: 'pix_created', order_status: 'waiting_payment', payment_method: 'pix',
        pix_code: '00020126580014br.gov.bcb.pix0136exemplo', pix_expiration: '31/12/2030 20:30', Customer: customer('+55 65 99999-0004'),
      }))
      const jobs = await jobsOf(ORDER_ID(4))
      assert.equal(jobs.length, 1, JSON.stringify(await lastWebhookSkip()))
      assert.equal(jobs[0].jobType, 'pix_followup_60m')
      assert.ok(jobs[0].scheduledFor!.getTime() - Date.now() > 55 * 60_000, 'espera 60 minutos')
      assert.equal((await runCron()).sent, 0, 'antes dos 60 minutos nada sai')
      await releaseAll()
      assert.equal((await runCron()).sent, 1, JSON.stringify(sent))
      const pixParams = lastParams(sent[0])
      assert.deepEqual(Object.keys(pixParams).sort(), ['customer_name', 'order_reference', 'pix_expiry'])
      assert.equal(pixParams.customer_name, 'Maria')
      assert.equal(pixParams.order_reference, 'Ab4Cd7E')
      assert.match(pixParams.pix_expiry ?? '', /31\/12\/2030/)
    })

    await test('opt-out persistido vence: nenhum dos quatro eventos agenda para quem pediu para parar', async () => {
      await reset()
      const phone = '5565999990005'
      await db.insert(schema.recoveryLeads).values({
        companyId: isabela.id, platform: 'kiwify', eventType: 'compra_aprovada', phone, name: 'Antiga', status: 'completed',
        whatsappConsentStatus: 'opted_out', botPaused: true, botPausedBy: 'optout_whatsapp', transactionId: 'antiga-1', orderDate: new Date(),
      })
      const events = [
        { webhook_event_type: 'order_approved', order_status: 'paid', payment_method: 'credit_card', approved_date: nowSp() },
        { webhook_event_type: 'billet_created', order_status: 'waiting_payment', payment_method: 'boleto', boleto_barcode: '123', boleto_expiry_date: '31/12/2030' },
        { webhook_event_type: 'pix_created', order_status: 'waiting_payment', payment_method: 'pix', pix_code: 'abc', pix_expiration: '31/12/2030 20:30' },
        { webhook_event_type: 'order_rejected', order_status: 'refused', payment_method: 'credit_card' },
      ]
      for (const [index, event] of events.entries()) {
        await postKiwify(isabela.slug, base(50 + index, { ...event, Customer: customer('+55 65 99999-0005') }))
        assert.equal((await jobsOf(ORDER_ID(50 + index))).length, 0, `evento ${event.webhook_event_type} não pode agendar`)
      }
      assert.equal((await runCron()).sent, 0)
      assert.equal(sent.length, 0)
    })

    await test('opt-out que chega DEPOIS de agendar cancela o job no cron; pausa individual de atendente também', async () => {
      await reset()
      await postKiwify(isabela.slug, base(6, {
        webhook_event_type: 'billet_created', order_status: 'waiting_payment', payment_method: 'boleto',
        boleto_barcode: '123', boleto_expiry_date: '31/12/2030', Customer: customer('+55 65 99999-0006'),
      }))
      await postKiwify(isabela.slug, base(7, {
        webhook_event_type: 'order_rejected', order_status: 'refused', payment_method: 'credit_card', Customer: customer('+55 65 99999-0007'),
      }))
      const [optOutLead, humanLead] = await db.select().from(schema.recoveryLeads).orderBy(schema.recoveryLeads.id)
      await db.update(schema.recoveryLeads).set({ whatsappConsentStatus: 'opted_out', botPausedBy: 'optout_whatsapp' }).where(eq(schema.recoveryLeads.id, optOutLead.id))
      await db.update(schema.recoveryLeads).set({ botPaused: true, botPausedAll: false, botPausedBy: 'Atendente Maria' }).where(eq(schema.recoveryLeads.id, humanLead.id))
      await releaseAll()
      assert.equal((await runCron()).sent, 0, JSON.stringify(sent))
      for (const job of await db.select().from(schema.messageJobs)) assert.equal(job.status, 'cancelled')
    })

    await test('nada retroativo: evento anterior ao corte (ou sem data) é registrado e NÃO vira job; job antigo já criado é cancelado no cron', async () => {
      await reset()
      await postKiwify(isabela.slug, base(8, {
        webhook_event_type: 'order_approved', order_status: 'paid', payment_method: 'credit_card',
        created_at: '2026-11-10 09:00', approved_date: '2026-11-10 09:00', Customer: customer('+55 65 99999-0008'),
      }))
      await postKiwify(isabela.slug, base(9, {
        webhook_event_type: 'billet_created', order_status: 'waiting_payment', payment_method: 'boleto',
        created_at: '2026-11-09 09:00', boleto_barcode: '123', boleto_expiry_date: '31/12/2030', Customer: customer('+55 65 99999-0009'),
      }))
      await postKiwify(isabela.slug, base(10, {
        webhook_event_type: 'pix_created', order_status: 'waiting_payment', payment_method: 'pix', created_at: undefined,
        pix_code: 'abc', pix_expiration: '31/12/2030 20:30', Customer: customer('+55 65 99999-0010'),
      }))
      for (const n of [8, 9, 10]) assert.equal((await jobsOf(ORDER_ID(n))).length, 0, `pedido ${n}`)
      const skips = await lastWebhookSkip()
      assert.equal(skips.filter(reason => reason === 'evento_isabela_anterior_ao_corte').length, 2, JSON.stringify(skips))
      assert.equal(skips.filter(reason => reason === 'evento_isabela_sem_data_de_ocorrencia').length, 1, JSON.stringify(skips))

      // Defesa em profundidade: job que já existia para um evento antigo.
      const [oldLead] = await db.insert(schema.recoveryLeads).values({
        companyId: isabela.id, platform: 'kiwify', eventType: 'boleto', phone: '5565999990011', name: 'Antigo', status: 'pending',
        transactionId: 'antigo-boleto', orderDate: new Date('2026-11-05T12:00:00Z'), whatsappConsentStatus: 'unknown',
      }).returning()
      const [boletoMsg] = await db.select().from(schema.sequenceMessages).where(eq(schema.sequenceMessages.templateName, 'boleto_despertar_nao_pago'))
      const [oldJob] = await db.insert(schema.messageJobs).values({
        leadId: oldLead.id, messageId: boletoMsg.id, scheduledFor: new Date(Date.now() - 60_000), status: 'pending',
        jobType: 'boleto_followup_immediate', idempotencyKey: 'antigo-1',
      }).returning()
      assert.equal((await runCron()).sent, 0)
      const [after] = await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.id, oldJob.id))
      assert.equal(after.status, 'cancelled')
      assert.match(after.error ?? '', /anterior_ao_corte/)
      assert.equal(sent.length, 0)
    })

    await test('convite do Portal (não é evento Kiwify): o corte de data NÃO se aplica; resultado idêntico ao baseline (opt-in segue exigido)', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: false, by: 'teste' })
      try {
        const [portalSeq] = await db.insert(schema.recoverySequences).values({ companyId: isabela.id, eventType: 'portal_apos_desafio', name: 'Portal', isActive: true }).returning()
        const [portalMsg] = await db.insert(schema.sequenceMessages).values({
          sequenceId: portalSeq.id, order: 1, delayMinutes: 0, messageType: 'template', templateName: 'convite_portal_apos_desafio',
          templateLanguage: 'pt_BR', templateVariablesMap: { customer_name: '{nome}' }, isActive: true,
        }).returning()
        const buyer = async (phone: string, consent: string) => (await db.insert(schema.recoveryLeads).values({
          companyId: isabela.id, platform: 'kiwify', eventType: 'compra_aprovada', phone, name: 'Compradora Antiga', status: 'completed',
          transactionId: `portal-${phone}`, orderDate: new Date('2026-11-01T12:00:00Z'), approvedDate: new Date('2026-11-01T12:00:00Z'), whatsappConsentStatus: consent,
        }).returning())[0]
        const optedIn = await buyer('5565999990020', 'opted_in')
        const unknown = await buyer('5565999990021', 'unknown')
        const job = async (leadId: number, key: string) => (await db.insert(schema.messageJobs).values({
          leadId, messageId: portalMsg.id, scheduledFor: new Date(Date.now() - 60_000), status: 'pending', jobType: 'isabela_portal_after_challenge', idempotencyKey: key,
        }).returning())[0]
        const optedInJob = await job(optedIn.id, 'portal-ok')
        const unknownJob = await job(unknown.id, 'portal-sem-optin')
        await runCron()
        const [a] = await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.id, optedInJob.id))
        const [b] = await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.id, unknownJob.id))
        // Nenhum dos dois é cancelado pelo corte (comprou em 01/11, antes do corte).
        assert.doesNotMatch(a.error ?? '', /corte/)
        assert.doesNotMatch(b.error ?? '', /corte/)
        // Baseline (origin/main, medido): o comprador com opted_in passa pelo gate de consentimento e é cancelado
        // só pelo gate de template do Portal (categoryOk UTILITY x portalCategoryOk MARKETING, contradição que já
        // existe no baseline e fica fora do escopo); sem opt_in segue cancelado por consentimento.
        assert.match(a.error ?? '', /Template explícito/)
        assert.match(b.error ?? '', /opted_in/)
      } finally {
        await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'teste' })
      }
    })

    await test('pedido já pago: pix/boleto/cartão chegando DEPOIS do order_approved do mesmo order_id não agenda; job de cobrança já na fila é cancelado no cron', async () => {
      await reset()
      const approved = base(30, {
        webhook_event_type: 'order_approved', order_status: 'paid', payment_method: 'pix', approved_date: nowSp(), Customer: customer('+55 65 99999-0030'),
      })
      await postKiwify(isabela.slug, approved)
      const late = (extra: Record<string, unknown>) => ({ ...approved, ...extra, webhook_event_type: extra.webhook_event_type })
      await postKiwify(isabela.slug, late({ webhook_event_type: 'pix_created', order_status: 'waiting_payment', pix_code: 'abc', pix_expiration: '31/12/2030 20:30' }))
      await postKiwify(isabela.slug, late({ webhook_event_type: 'billet_created', order_status: 'waiting_payment', payment_method: 'boleto', boleto_barcode: '123', boleto_expiry_date: '31/12/2030' }))
      await postKiwify(isabela.slug, late({ webhook_event_type: 'order_rejected', order_status: 'refused', payment_method: 'credit_card' }))
      const jobs = await jobsOf(ORDER_ID(30))
      assert.deepEqual(jobs.map(j => j.jobType).sort(), ['isabela_purchase_sequence', 'isabela_purchase_sequence', 'isabela_purchase_sequence'], 'só a sequência da compra; nenhuma cobrança')
      const skips = await lastWebhookSkip()
      assert.equal(skips.filter(reason => reason === 'pedido_ja_pago_compra_aprovada').length, 3, JSON.stringify(skips))
      await releaseAll()
      assert.equal((await runCron()).sent, 1)
      assert.equal(sent[0].templateName, 'boas_vindas_despertar_pos_compra')
      assert.equal(sent.some(m => ['pix_despertar_nao_pago', 'boleto_despertar_nao_pago', 'cartao_despertar_recusado'].includes(m.templateName ?? '')), false)

      // Defesa no cron: cobrança agendada antes de o order_approved existir.
      await reset()
      const [pixLead] = await db.insert(schema.recoveryLeads).values({
        companyId: isabela.id, platform: 'kiwify', eventType: 'pix', phone: '5565999990031', name: 'Maria', status: 'pending', paymentType: 'pix', pixCode: 'abc',
        pixExpiry: new Date(Date.now() + 3600_000), transactionId: 'pedido-pago-1', orderDate: new Date(), whatsappConsentStatus: 'unknown',
      }).returning()
      await db.insert(schema.recoveryLeads).values({
        companyId: isabela.id, platform: 'kiwify', eventType: 'compra_aprovada', phone: '5565999990031', name: 'Maria', status: 'completed',
        transactionId: 'pedido-pago-1', orderDate: new Date(), approvedDate: new Date(), whatsappConsentStatus: 'unknown',
      })
      const [pixMsg] = await db.select().from(schema.sequenceMessages).where(eq(schema.sequenceMessages.templateName, 'pix_despertar_nao_pago'))
      const [pixJob] = await db.insert(schema.messageJobs).values({
        leadId: pixLead.id, messageId: pixMsg.id, scheduledFor: new Date(Date.now() - 60_000), status: 'pending', jobType: 'pix_followup_60m', idempotencyKey: 'pago-pix',
      }).returning()
      assert.equal((await runCron()).sent, 0)
      const [after] = await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.id, pixJob.id))
      assert.equal(after.status, 'cancelled')
      assert.match(after.error ?? '', /já pago/)
    })

    await test('order_reference sem order_ref usa os 8 primeiros caracteres do order_id', async () => {
      await reset()
      await postKiwify(isabela.slug, { ...base(31, { webhook_event_type: 'order_rejected', order_status: 'refused', payment_method: 'credit_card', Customer: customer('+55 65 99999-0032') }), order_ref: undefined })
      await releaseAll()
      assert.equal((await runCron()).sent, 1, JSON.stringify(sent))
      assert.equal(lastParams(sent[0]).order_reference, '0a1b2c3d')
    })

    await test('pausa geral continua bloqueando o que está fora da lista: job sem jobType, upsell e Portal sem opt_in', async () => {
      await reset()
      const [lead] = await db.insert(schema.recoveryLeads).values({
        companyId: isabela.id, platform: 'kiwify', eventType: 'compra_aprovada', phone: '5565999990012', name: 'Maria', status: 'pending',
        transactionId: 'pausa-1', orderDate: new Date(), whatsappConsentStatus: 'unknown', botPaused: true, botPausedAll: true, botPausedBy: 'auto (pausa geral ativa)',
      }).returning()
      const [welcome] = await db.select().from(schema.sequenceMessages).where(eq(schema.sequenceMessages.templateName, 'boas_vindas_despertar_pos_compra'))
      const past = new Date(Date.now() - 60_000)
      const semTipo = (await db.insert(schema.messageJobs).values({ leadId: lead.id, messageId: welcome.id, scheduledFor: past, status: 'pending' }).returning())[0]
      const upsell = (await db.insert(schema.messageJobs).values({ leadId: lead.id, upsellContent: 'Oferta', scheduledFor: past, status: 'pending' }).returning())[0]
      const portal = (await db.insert(schema.messageJobs).values({ leadId: lead.id, messageId: welcome.id, scheduledFor: past, status: 'pending', jobType: 'isabela_portal_after_challenge', idempotencyKey: 'portal-1' }).returning())[0]
      assert.equal((await runCron()).sent, 0)
      for (const job of [semTipo, upsell, portal]) {
        const [after] = await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.id, job.id))
        assert.equal(after.status, 'cancelled', `job ${job.id}`)
      }
      assert.equal(sent.length, 0)
    })

    await test('outras empresas: jobType da Isabela em outro tenant sem opt_in segue cancelado; evento Kiwify de outro tenant não passa pelo corte nem pela isenção', async () => {
      await reset()
      const [lead] = await db.insert(schema.recoveryLeads).values({
        companyId: generic.id, platform: 'kiwify', eventType: 'pix', phone: '5551999990013', name: 'Outro', status: 'pending',
        paymentType: 'pix', pixCode: 'abc', pixExpiry: new Date(Date.now() + 3600_000), transactionId: 'outro-pix', orderDate: new Date(), whatsappConsentStatus: 'unknown',
      }).returning()
      const [gSeq] = await db.insert(schema.recoverySequences).values({ companyId: generic.id, eventType: 'pix', name: 'Pix G', isActive: true }).returning()
      const [gMsg] = await db.insert(schema.sequenceMessages).values({ sequenceId: gSeq.id, order: 1, delayMinutes: 60, messageType: 'template', templateName: 'pix_despertar_nao_pago', templateLanguage: 'pt_BR', isActive: true }).returning()
      const [job] = await db.insert(schema.messageJobs).values({
        leadId: lead.id, messageId: gMsg.id, scheduledFor: new Date(Date.now() - 60_000), status: 'pending', jobType: 'pix_followup_60m', idempotencyKey: 'outro-1',
      }).returning()
      assert.equal((await runCron()).sent, 0)
      const [after] = await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.id, job.id))
      assert.equal(after.status, 'cancelled')
      assert.match(after.error ?? '', /consentimento|opted_in/)

      // Boleto antigo de outra empresa não sofre o corte da Isabela: o job é criado como antes.
      const gBoleto = (await db.insert(schema.recoverySequences).values({ companyId: generic.id, eventType: 'boleto', name: 'Boleto G', isActive: true }).returning())[0]
      await db.insert(schema.sequenceMessages).values({ sequenceId: gBoleto.id, order: 1, delayMinutes: 0, messageType: 'text', content: 'Seu boleto {nome}', isActive: true })
      await postKiwify(generic.slug, base(14, {
        webhook_event_type: 'billet_created', order_status: 'waiting_payment', payment_method: 'boleto', created_at: '2026-10-01 09:00',
        boleto_barcode: '123', boleto_expiry_date: '31/12/2030', Customer: customer('+55 51 99999-0014'),
      }))
      assert.equal((await jobsOf(ORDER_ID(14))).length, 1, 'outro tenant mantém o comportamento de antes')
    })
  } finally {
    await fixture.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
