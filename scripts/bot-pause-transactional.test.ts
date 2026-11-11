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

  let authCompany = { id: 2, name: 'Isabela', slug: 'isabela-fanini' }
  mock.module('@/lib/auth', { namedExports: { requireCompany: async () => authCompany, getCurrentUser: async () => ({ displayName: 'Op', primaryEmail: 'op@teste.local' }) } })

  const cron = await import('../src/app/api/cron/route')
  const kiwify = await import('../src/app/api/webhooks/kiwify/[slug]/route')
  const leadsApi = await import('../src/app/api/leads/route')
  const { setPauseSwitch } = await import('../src/lib/bot-pause')
  const {
    classifyMessageJob, pauseAppliesToJob, isOptOutPause, isSwitchGeneratedPause, isHardLeadPause,
    isPauseBypassAllowed, TRANSACTIONAL_BYPASS_ALLOWLIST, CONVERSATIONAL_JOB_TYPES,
  } = await import('../src/lib/message-job-class')
  const { PIX_FOLLOWUP_JOB_TYPE, isRealPendingPix } = await import('../src/lib/pix-followup-policy')
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
  const newMessage = async (sequenceId: number, templateName: string | null, delayMinutes = 0) => {
    const [m] = await db.insert(schema.sequenceMessages).values({
      sequenceId, order: 1, delayMinutes, messageType: templateName ? 'template' : 'text',
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
  const SWITCH_PAUSE = { botPaused: true, botPausedBy: 'Administrador (Agente IA)', botPausedAll: true }
  const INDIVIDUAL_PAUSE = { botPaused: true, botPausedBy: 'Atendente Maria', botPausedAll: false }

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
    const [isabelaBoletoSeq] = await db.insert(schema.recoverySequences).values({ companyId: isabela.id, eventType: 'boleto', name: 'Boleto Isabela', isActive: true }).returning()
    const genericMsg = await newMessage(genericSeq.id, 'boleto_generico')
    const welcomeMsg = await newMessage(isabelaSeq.id, 'boas_vindas_despertar_pos_compra')
    const pixMsg = await newMessage(isabelaSeq.id, 'pix_despertar_nao_pago', 60)
    const portalMsg = await newMessage(isabelaSeq.id, 'convite_portal_apos_desafio')
    const boletoMsg = await newMessage(isabelaBoletoSeq.id, 'boleto_despertar_nao_pago')
    await db.update(schema.sequenceMessages).set({
      templateVariablesMap: { '1': '{nome}', '2': '{boleto_codigo}', '3': '{boleto_validade}' },
    }).where(eq(schema.sequenceMessages.id, boletoMsg.id))
    for (const [name, category] of [
      ['boas_vindas_despertar_pos_compra', 'MARKETING'], ['pix_despertar_nao_pago', 'UTILITY'],
      ['convite_portal_apos_desafio', 'MARKETING'], ['boleto_despertar_nao_pago', 'UTILITY'],
    ] as const) {
      await db.insert(schema.metaMessageTemplates).values({ companyId: isabela.id, name, language: 'pt_BR', status: 'APPROVED', category, components: [{ type: 'BODY', text: 'Olá {{1}}' }] })
    }

    await test('(A)(B) classificação: só jobType EXPLÍCITO na lista de permissão da Isabela/Kiwify escapa; estado do lead não conta', () => {
      assert.deepEqual(TRANSACTIONAL_BYPASS_ALLOWLIST.map(r => r.companySlug), ['isabela-fanini'])
      const rule = TRANSACTIONAL_BYPASS_ALLOWLIST[0]
      assert.ok(rule.jobTypes.includes(PIX_FOLLOWUP_JOB_TYPE))
      assert.ok(rule.jobTypes.includes(ISABELA_BOLETO_JOB_TYPE))
      for (const t of ISABELA_FLOW_JOB_TYPES) assert.ok(rule.jobTypes.includes(t) || CONVERSATIONAL_JOB_TYPES.has(t), `jobType ${t} sem classe`)
      const kiwify = { platform: 'kiwify' }
      for (const t of rule.jobTypes) assert.equal(classifyMessageJob({ jobType: t }, kiwify, 'isabela-fanini'), 'transactional', t)
      assert.equal(classifyMessageJob({ jobType: 'isabela_portal_after_challenge' }, kiwify, 'isabela-fanini'), 'conversational')
      // Sem jobType: SEMPRE promocional, qualquer plataforma e qualquer eventType (o lead não é prova).
      for (const platform of ['kiwify', 'hotmart', 'greenn', 'zouti', 'sac']) {
        assert.equal(classifyMessageJob({ jobType: null }, { platform }, 'isabela-fanini'), 'promotional', platform)
        assert.equal(classifyMessageJob({ jobType: null }, { platform }, 'empresa-generica'), 'promotional', platform)
      }
      // Outras empresas e outras plataformas, mesmo com jobType da lista: bloqueado (como antes).
      for (const t of rule.jobTypes) {
        assert.equal(classifyMessageJob({ jobType: t }, kiwify, 'empresa-generica'), 'promotional', t)
        assert.equal(classifyMessageJob({ jobType: t }, { platform: 'hotmart' }, 'isabela-fanini'), 'promotional', t)
        assert.equal(classifyMessageJob({ jobType: t }, { platform: 'Kiwify' }, 'isabela-fanini'), 'promotional', t)
        assert.equal(classifyMessageJob({ jobType: t }, kiwify, null), 'promotional', t)
      }
      assert.equal(isPauseBypassAllowed({ jobType: 'pix_followup_60m' }, kiwify, 'empresa-generica'), false)
      // Upsell e lote em massa nunca escapam, mesmo com jobType da lista.
      assert.equal(classifyMessageJob({ jobType: 'isabela_purchase_sequence', upsellContent: 'x' }, kiwify, 'isabela-fanini'), 'promotional')
      assert.equal(classifyMessageJob({ jobType: 'isabela_purchase_sequence', massDispatchBatchId: 9 }, kiwify, 'isabela-fanini'), 'promotional')
      assert.equal(classifyMessageJob({ jobType: 'tipo_desconhecido' }, kiwify, 'isabela-fanini'), 'promotional')
      assert.equal(pauseAppliesToJob('transactional'), false)
      assert.equal(pauseAppliesToJob('conversational'), true)
      assert.equal(pauseAppliesToJob('promotional'), true)
    })

    await test('(C) tipos de pausa: só a gerada pela chave/Pausar tudo/Pausar canal é ignorável; atendente e opt-out são duras', () => {
      assert.equal(isSwitchGeneratedPause({ botPaused: true, botPausedAll: true, botPausedBy: 'Administrador (Agente IA)' }), true)
      assert.equal(isSwitchGeneratedPause({ botPaused: true, botPausedChannel: 'whatsapp', botPausedBy: 'x' }), true)
      assert.equal(isSwitchGeneratedPause({ botPaused: true, botPausedBy: 'auto (pausa geral ativa)' }), true)
      assert.equal(isSwitchGeneratedPause({ botPaused: true, botPausedBy: 'auto (canal whatsapp pausado)' }), true)
      for (const by of ['Atendente Maria', 'tag:pessoa', 'optout_whatsapp', 'revisao_possivel_optout', null]) {
        assert.equal(isSwitchGeneratedPause({ botPaused: true, botPausedAll: false, botPausedChannel: null, botPausedBy: by }), false, String(by))
        assert.equal(isHardLeadPause({ botPaused: true, botPausedAll: false, botPausedChannel: null, botPausedBy: by }), true, String(by))
      }
      // opt-out com flag de pausa geral colada: continua duro.
      assert.equal(isSwitchGeneratedPause({ botPaused: true, botPausedAll: true, botPausedBy: 'optout_whatsapp' }), false)
      assert.equal(isHardLeadPause({ botPaused: false }), false)
      assert.equal(isOptOutPause({ botPaused: true, botPausedBy: 'optout_whatsapp' }), true)
      assert.equal(isOptOutPause({ botPaused: false, botPausedBy: 'optout_whatsapp' }), false)
    })

    await test('(C) gate do Pix: padrão = como antes (qualquer pausa barra); com bypass só a pausa da chave é ignorada; opt-out e atendente barram', () => {
      const pix = {
        eventType: 'pix', paymentType: 'pix', phone: 'p', transactionId: 't', pixCode: 'c',
        pixExpiry: new Date(Date.now() + 3600_000), status: 'pending', approvedDate: null, whatsappConsentStatus: 'opted_in',
      }
      const sw = { ...pix, ...SWITCH_PAUSE }
      assert.equal(isRealPendingPix(sw).eligible, false, 'sem bypass: como antes')
      assert.equal(isRealPendingPix(sw, { ignoreSwitchPause: true }).eligible, true)
      assert.equal(isRealPendingPix({ ...pix, ...INDIVIDUAL_PAUSE }, { ignoreSwitchPause: true }).eligible, false)
      assert.equal(isRealPendingPix({ ...pix, botPaused: true, botPausedBy: 'tag:pessoa' }, { ignoreSwitchPause: true }).eligible, false)
      assert.equal(isRealPendingPix({ ...sw, botPausedBy: 'optout_whatsapp' }, { ignoreSwitchPause: true }).eligible, false)
      assert.equal(isRealPendingPix({ ...pix, botPaused: false }).eligible, true)
    })

    await test('chave GERAL ligada: funil e boleto da Isabela/Kiwify ENVIADOS; follow-up, portal, upsell, lote, outras empresas e job sem jobType BLOQUEADOS', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'teste' })
      await setPauseSwitch({ companyId: generic.id, scope: 'all', active: true, by: 'teste' })

      const funnelLead = await newLead(isabela.id, { eventType: 'compra_aprovada', ...SWITCH_PAUSE, botPausedBy: 'auto (pausa geral ativa)' })
      const funnelJob = await newJob(funnelLead.id, welcomeMsg.id, { jobType: 'isabela_purchase_sequence', idempotencyKey: 'k1' })
      const boletoLead = await newLead(isabela.id, { eventType: 'boleto', ...SWITCH_PAUSE })
      const boletoJob = await newJob(boletoLead.id, boletoMsg.id, { jobType: 'boleto_followup_immediate', idempotencyKey: 'k-b' })

      // Mesmo lead da Isabela: sequência de evento (transacional) + upsell (promocional).
      const buyLead = await newLead(isabela.id, { eventType: 'compra_aprovada', ...SWITCH_PAUSE })
      const buySeqJob = await newJob(buyLead.id, welcomeMsg.id, { jobType: 'isabela_purchase_sequence', idempotencyKey: 'k-buy' })
      const upsellJob = await newJob(buyLead.id, null, { upsellContent: 'Oferta especial {nome}' })

      const portalLead = await newLead(isabela.id, { eventType: 'compra_aprovada' })
      const portalJob = await newJob(portalLead.id, portalMsg.id, { jobType: 'isabela_portal_after_challenge', idempotencyKey: 'k2' })

      // (A) Q3-3: outreach manual em lead Kiwify da Isabela (job SEM jobType, eventType forjado): bloqueado.
      const manualKiwify = await newLead(isabela.id, { eventType: 'carrinho_abandonado' })
      const manualKiwifyJob = await newJob(manualKiwify.id, welcomeMsg.id, { checkBeforeSend: true })
      // (B) Outras empresas/plataformas: recuperação de carrinho e boleto genérico continuam bloqueados.
      const gCart = await newLead(generic.id, { platform: 'hotmart', eventType: 'carrinho_abandonado' })
      const gCartJob = await newJob(gCart.id, genericMsg.id, { checkBeforeSend: true })
      const gBoleto = await newLead(generic.id, { eventType: 'boleto' })
      const gBoletoJob = await newJob(gBoleto.id, genericMsg.id)
      const gTyped = await newLead(generic.id, { eventType: 'pix' })
      const gTypedJob = await newJob(gTyped.id, genericMsg.id, { jobType: 'pix_followup_60m' })
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
      for (const ok of [funnelJob, boletoJob, buySeqJob]) assert.equal((await jobById(ok.id)).status, 'sent', `job ${ok.id} deveria sair`)
      for (const blocked of [upsellJob, portalJob, manualKiwifyJob, gCartJob, gBoletoJob, gTypedJob, manualJob, massJob]) {
        assert.equal((await jobById(blocked.id)).status, 'cancelled', `job ${blocked.id} deveria ser bloqueado`)
      }
      assert.match((await jobById(upsellJob.id)).error ?? '', /Pausa da empresa|bot pausado/)
      assert.deepEqual(sent.map(s => s.templateName).sort(), ['boas_vindas_despertar_pos_compra', 'boas_vindas_despertar_pos_compra', 'boleto_despertar_nao_pago'])
    })

    await test('(A) POST /api/leads em lead Kiwify existente (sobrescreve eventType e cria jobs sem jobType) NÃO fura a pausa', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'teste' })
      const lead = await newLead(isabela.id, { eventType: 'compra_aprovada', ...SWITCH_PAUSE })
      const [seq] = await db.insert(schema.recoverySequences).values({ companyId: isabela.id, eventType: 'carrinho_abandonado', name: 'Manual', isActive: true }).returning()
      await newMessage(seq.id, 'boas_vindas_despertar_pos_compra')
      const res = await leadsApi.POST(new NextRequest('http://localhost/api/leads', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: lead.phone, triggerSequence: true, eventType: 'carrinho_abandonado' }),
      }))
      assert.equal(res.status, 200, await res.clone().text())
      const jobs = await db.select().from(schema.messageJobs)
      assert.equal(jobs.length, 1, 'POST /api/leads com triggerSequence cria job sem jobType')
      assert.equal(jobs[0].jobType, null)
      assert.equal((await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.id, lead.id)))[0].eventType, 'carrinho_abandonado', 'eventType do lead existente foi sobrescrito (cenário Q3-3)')
      await runCron()
      for (const j of jobs) assert.equal((await jobById(j.id)).status, 'cancelled', `job ${j.id} do outreach manual tem que ser bloqueado`)
      assert.equal(sent.length, 0)
    })

    await test('Pix pendente da Isabela sai com a chave ligada e pausa da chave; pausa individual de atendente BLOQUEIA (inclusive o gate do Pix)', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'teste' })
      const pixValues = { eventType: 'pix', paymentType: 'pix', pixCode: 'copia-e-cola', pixExpiry: new Date(Date.now() + 3600_000) }
      const swLead = await newLead(isabela.id, { ...pixValues, ...SWITCH_PAUSE })
      const swJob = await newJob(swLead.id, pixMsg.id, { jobType: 'pix_followup_60m', checkBeforeSend: true, idempotencyKey: 'pix-1' })
      const humanLead = await newLead(isabela.id, { ...pixValues, ...INDIVIDUAL_PAUSE })
      const humanJob = await newJob(humanLead.id, pixMsg.id, { jobType: 'pix_followup_60m', checkBeforeSend: true, idempotencyKey: 'pix-2' })
      await runCron()
      assert.equal((await jobById(swJob.id)).status, 'sent')
      assert.equal((await jobById(humanJob.id)).status, 'cancelled')
      assert.deepEqual(sent.map(s => s.templateName), ['pix_despertar_nao_pago'])
    })

    await test('(C) agendamento do Pix (schedulePixFollowup): Isabela agenda sob pausa da chave e não sob pausa de atendente; outra empresa mantém o gate de antes', async () => {
      await reset()
      const { schedulePixFollowup } = await import('../src/lib/pix-followup')
      const [pixSeq] = await db.insert(schema.recoverySequences).values({ companyId: isabela.id, eventType: 'pix', name: 'Pix', isActive: true }).returning()
      const m1 = await newMessage(pixSeq.id, 'pix_despertar_nao_pago', 60)
      const [gPixSeq] = await db.insert(schema.recoverySequences).values({ companyId: generic.id, eventType: 'pix', name: 'Pix G', isActive: true }).returning()
      const m2 = await newMessage(gPixSeq.id, 'pix_despertar_nao_pago', 60)
      for (const m of [m1, m2]) await db.update(schema.sequenceMessages).set({ templateVariablesMap: { '1': '{nome}', '2': '{pix_validade}' } }).where(eq(schema.sequenceMessages.id, m.id))
      const pixValues = { eventType: 'pix', paymentType: 'pix', pixCode: 'copia-e-cola', pixExpiry: new Date(Date.now() + 3600_000) }
      const sw = await newLead(isabela.id, { ...pixValues, ...SWITCH_PAUSE })
      const human = await newLead(isabela.id, { ...pixValues, ...INDIVIDUAL_PAUSE })
      const other = await newLead(generic.id, { ...pixValues, ...SWITCH_PAUSE })
      assert.equal((await schedulePixFollowup(sw)).scheduled, true)
      assert.equal((await schedulePixFollowup(human)).scheduled, false)
      assert.equal((await schedulePixFollowup(other)).scheduled, false, 'fora da lista: gate do Pix como antes')
    })

    await test('(C) pausa individual de atendente barra o transacional e derruba os irmãos; pausa da chave não', async () => {
      await reset()
      const human = await newLead(isabela.id, { eventType: 'compra_aprovada', ...INDIVIDUAL_PAUSE })
      const h1 = await newJob(human.id, welcomeMsg.id, { jobType: 'isabela_purchase_sequence', idempotencyKey: 'h1' })
      const h2 = await newJob(human.id, welcomeMsg.id, { jobType: 'isabela_purchase_sequence', idempotencyKey: 'h2' })
      const viaTag = await newLead(isabela.id, { eventType: 'compra_aprovada', botPaused: true, botPausedBy: 'tag:pessoa' })
      const t1 = await newJob(viaTag.id, welcomeMsg.id, { jobType: 'isabela_purchase_sequence', idempotencyKey: 't1' })
      const byChannel = await newLead(isabela.id, { eventType: 'compra_aprovada', botPaused: true, botPausedBy: 'x', botPausedChannel: 'whatsapp' })
      const c1 = await newJob(byChannel.id, welcomeMsg.id, { jobType: 'isabela_purchase_sequence', idempotencyKey: 'c1' })
      await runCron()
      for (const j of [h1, h2, t1]) assert.equal((await jobById(j.id)).status, 'cancelled')
      assert.equal((await jobById(c1.id)).status, 'sent')
      assert.equal((await jobById(h1.id)).error, 'Lead com bot pausado antes do envio')
    })

    await test('chave só do canal WhatsApp ligada: transacional da Isabela sai; follow-up promocional não; chave do Instagram não afeta o WhatsApp', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'whatsapp', active: true, by: 'teste' })
      const tx = await newLead(isabela.id, { eventType: 'compra_aprovada' })
      const txJob = await newJob(tx.id, welcomeMsg.id, { jobType: 'isabela_purchase_sequence', idempotencyKey: 'w1' })
      const fo = await newLead(generic.id, { platform: 'import_planilha', eventType: 'atendimento' })
      await setPauseSwitch({ companyId: generic.id, scope: 'whatsapp', active: true, by: 'teste' })
      const foJob = await newJob(fo.id, genericMsg.id)
      await runCron()
      assert.equal((await jobById(txJob.id)).status, 'sent')
      assert.equal((await jobById(foJob.id)).status, 'cancelled')
      await reset()
      await setPauseSwitch({ companyId: generic.id, scope: 'instagram', active: true, by: 'teste' })
      const fo2 = await newLead(generic.id, { platform: 'import_planilha', eventType: 'atendimento' })
      const foJob2 = await newJob(fo2.id, genericMsg.id)
      await runCron()
      assert.equal((await jobById(foJob2.id)).status, 'sent', 'chave de outro canal não bloqueia o WhatsApp')
    })

    await test('opt-out e consentimento continuam bloqueando o transacional', async () => {
      await reset()
      const mk = async (values: Partial<typeof schema.recoveryLeads.$inferInsert>, key: string) => {
        const l = await newLead(isabela.id, { eventType: 'compra_aprovada', ...values })
        return newJob(l.id, welcomeMsg.id, { jobType: 'isabela_purchase_sequence', idempotencyKey: key })
      }
      const jobs = [
        await mk({ ...SWITCH_PAUSE, botPausedBy: 'optout_whatsapp', whatsappConsentStatus: 'opted_out' }, 'o1'),
        await mk({ ...SWITCH_PAUSE, botPausedBy: 'revisao_possivel_optout' }, 'o2'),
        await mk({ whatsappConsentStatus: 'opted_out' }, 'o3'),
        await mk({ whatsappConsentStatus: 'unknown' }, 'o4'),
      ]
      const result = await runCron()
      assert.equal(result.sent, 0, JSON.stringify(sent))
      for (const j of jobs) assert.equal((await jobById(j.id)).status, 'cancelled')
    })

    await test('ponta a ponta Isabela: webhook Kiwify (boleto, opt-in explícito) com a chave ligada cria lead pausado, agenda job com jobType explícito e o cron ENVIA', async () => {
      await reset()
      await setPauseSwitch({ companyId: isabela.id, scope: 'all', active: true, by: 'teste' })
      const payload = {
        webhook_event_type: 'billet_created', order_id: 'ORDER-E2E-1', order_status: 'waiting_payment', payment_method: 'boleto',
        boleto_URL: 'https://boleto.exemplo/1', boleto_barcode: '123456789', boleto_expiry_date: '30/12/2030',
        created_at: '2026-11-11 10:00', whatsapp_opt_in: true,
        Product: { product_id: 'p1', product_name: 'Despertar das Bellas' },
        Customer: { full_name: 'Cliente E2E', mobile: '+55 51 99999-1234', email: 'e2e@exemplo.test' },
        Commissions: { charge_amount: 9700 },
      }
      const res = await kiwify.POST(
        new NextRequest(`http://localhost/api/webhooks/kiwify/${isabela.slug}?token=webhook-local`, { method: 'POST', body: JSON.stringify(payload) }),
        { params: Promise.resolve({ slug: isabela.slug }) },
      )
      assert.equal(res.status, 200, await res.clone().text())
      const [lead] = await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.transactionId, 'ORDER-E2E-1'))
      assert.ok(lead, 'lead criado pelo webhook')
      assert.equal(lead.botPaused, true, 'a IA não conversa com lead criado sob a chave')
      const jobs = await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.leadId, lead.id))
      assert.equal(jobs.length, 1, 'o job de evento é agendado mesmo com a chave ligada')
      assert.equal(jobs[0].jobType, 'boleto_followup_immediate', 'jobType explícito gravado pelo webhook')
      const result = await runCron()
      assert.equal(result.sent, 1, JSON.stringify({ result, job: await jobById(jobs[0].id) }))
      assert.equal((await jobById(jobs[0].id)).status, 'sent')
      assert.equal(sent[0].phone, lead.phone)
    })

    await test('(B) ponta a ponta outra empresa: webhook Kiwify de boleto agenda job sem jobType e a pausa o bloqueia, como antes', async () => {
      await reset()
      await setPauseSwitch({ companyId: generic.id, scope: 'all', active: true, by: 'teste' })
      const payload = {
        webhook_event_type: 'billet_created', order_id: 'ORDER-GEN-1', order_status: 'waiting_payment', payment_method: 'boleto',
        boleto_URL: 'https://boleto.exemplo/2', boleto_barcode: '987654321', boleto_expiry_date: '30/12/2030',
        created_at: '2026-11-11 10:00', Product: { product_id: 'p2', product_name: 'Produto Generico' },
        Customer: { full_name: 'Cliente Gen', mobile: '+55 51 98888-1234', email: 'gen@exemplo.test' }, Commissions: { charge_amount: 9700 },
      }
      const res = await kiwify.POST(
        new NextRequest(`http://localhost/api/webhooks/kiwify/${generic.slug}?token=webhook-local`, { method: 'POST', body: JSON.stringify(payload) }),
        { params: Promise.resolve({ slug: generic.slug }) },
      )
      assert.equal(res.status, 200, await res.clone().text())
      const [lead] = await db.select().from(schema.recoveryLeads).where(eq(schema.recoveryLeads.transactionId, 'ORDER-GEN-1'))
      const jobs = await db.select().from(schema.messageJobs).where(eq(schema.messageJobs.leadId, lead.id))
      assert.equal(jobs.length, 1)
      assert.equal(jobs[0].jobType, null)
      await db.update(schema.messageJobs).set({ scheduledFor: PAST }).where(eq(schema.messageJobs.id, jobs[0].id))
      await runCron()
      assert.equal((await jobById(jobs[0].id)).status, 'cancelled')
      assert.equal(sent.length, 0)
    })
  } finally {
    await fixture.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
