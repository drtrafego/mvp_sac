export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { agendaBlockedDates, companies, massDispatchPhoneCooldowns, messageJobs, nativeAvailabilitySchedules, recoveryLeads, sequenceMessages, settings, whatsappMessages } from '@/lib/db/schema'
import { eq, lte, and, gt, desc, inArray, or, sql } from 'drizzle-orm'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { markLeadContacted } from '@/lib/leads'
import { MAX_JOBS_PER_RUN, checkMetaWindowForJob, calculateDispatchSpacingMs } from '@/lib/message-jobs-policy'
import { executeAndRecordDispatch, type DispatchOutcome, type MessageSnapshot } from '@/lib/mass-dispatch'
import { releaseCronDispatchLock, tryAcquireCronDispatchLock } from '@/lib/cron-advisory-lock'
import { evaluateDispatchWindow, firstDueJobPerLead, retryAtAfterPreviousFollowupStep, selectFollowupDispatchSchedule, shouldApplyFollowupDispatchWindow } from '@/lib/followup-dispatch-policy'
import { isNativeAvailabilityCompany, normalizeAvailabilitySchedule } from '@/lib/agenda-schedule'
import { shouldSyncHermesAgenda } from '@/lib/hermes-control-panel'
import { evaluateSacPendingRules } from '@/lib/sac-pending-rules'

const DEFAULT_PROCESSING_LEASE_TIMEOUT_MS = 5 * 60_000

function processingLeaseTimeoutMs(): number {
  const configured = Number.parseInt(process.env.MASS_DISPATCH_PROCESSING_LEASE_TIMEOUT_MS ?? '', 10)
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_PROCESSING_LEASE_TIMEOUT_MS
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function formatCurrency(cents: number | null | undefined): string {
  if (cents == null) return ''
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString('pt-BR')
}

function interpolate(text: string | null | undefined, lead: {
  name?: string | null
  email?: string | null
  phone?: string | null
  productName?: string | null
  transactionId?: string | null
  cpfCnpj?: string | null
  city?: string | null
  state?: string | null
  productValue?: number | null
  paymentType?: string | null
  installments?: number | null
  boletoCode?: string | null
  boletoUrl?: string | null
  boletoExpiry?: Date | null
  pixCode?: string | null
  pixExpiry?: Date | null
  checkoutUrl?: string | null
  trackingSource?: string | null
  affiliateCode?: string | null
}): string {
  if (!text) return ''
  const nome = lead.name ?? 'Cliente'
  const primNome = nome.split(' ')[0]
  return text
    .replace(/\{nome\}/gi, nome)
    .replace(/\{primeiro_nome\}/gi, primNome)
    .replace(/\{email\}/gi, lead.email ?? '')
    .replace(/\{telefone\}/gi, lead.phone ?? '')
    .replace(/\{produto\}/gi, lead.productName ?? '')
    .replace(/\{transacao\}/gi, lead.transactionId ?? '')
    .replace(/\{cpf\}/gi, lead.cpfCnpj ?? '')
    .replace(/\{cidade\}/gi, lead.city ?? '')
    .replace(/\{estado\}/gi, lead.state ?? '')
    .replace(/\{valor\}/gi, formatCurrency(lead.productValue))
    .replace(/\{parcelas\}/gi, lead.installments?.toString() ?? '1')
    .replace(/\{forma_pagamento\}/gi, lead.paymentType ?? '')
    .replace(/\{boleto_codigo\}/gi, lead.boletoCode ?? '')
    .replace(/\{boleto_url\}/gi, lead.boletoUrl ?? '')
    .replace(/\{boleto_validade\}/gi, formatDate(lead.boletoExpiry))
    .replace(/\{pix_codigo\}/gi, lead.pixCode ?? '')
    .replace(/\{pix_validade\}/gi, formatDate(lead.pixExpiry))
    .replace(/\{link_checkout\}/gi, lead.checkoutUrl ?? '')
    .replace(/\{afiliado\}/gi, lead.affiliateCode ?? '')
}

async function recordJobOutcome(jobId: number, result: DispatchOutcome, metaPhoneNumberId?: string | null): Promise<void> {
  if (result.status === 'sent') {
    await db.update(messageJobs).set({
      status: 'sent', sentAt: result.sentAt, externalWamid: result.externalWamid,
      deliveryStatus: 'sent', error: null, processingStartedAt: null,
    }).where(eq(messageJobs.id, jobId))
  } else if (result.status === 'sent_unconfirmed') {
    await db.update(messageJobs).set({
      status: 'sent_unconfirmed', sentAt: result.sentAt, externalWamid: result.externalWamid,
      deliveryStatus: 'accepted_unconfirmed', error: result.error, processingStartedAt: null,
    }).where(eq(messageJobs.id, jobId))
  } else if (result.status === 'rate_limited') {
    await db.transaction(async tx => {
      await tx.update(messageJobs).set({
        status: 'pending', scheduledFor: result.retryAt, error: result.error,
        retryCount: sql`${messageJobs.retryCount} + 1`, processingStartedAt: null,
      }).where(eq(messageJobs.id, jobId))
      if (metaPhoneNumberId) {
        await tx.insert(massDispatchPhoneCooldowns).values({
          metaPhoneNumberId,
          cooldownUntil: result.retryAt,
          reason: result.error,
          updatedAt: new Date(),
        }).onConflictDoUpdate({
          target: massDispatchPhoneCooldowns.metaPhoneNumberId,
          set: {
            cooldownUntil: result.retryAt,
            reason: result.error,
            updatedAt: new Date(),
          },
        })
      }
    })
  } else {
    await db.update(messageJobs).set({ status: 'failed', error: result.error, processingStartedAt: null }).where(eq(messageJobs.id, jobId))
  }
}

// O Vercel Cron só aciona rota por GET (mesmo padrão de /api/cron/sync-agents).
// Esta rota nasceu só com POST e por isso NUNCA foi ligada a nenhum agendador:
// achado em 23/09/2026, 7 dias de log da Vercel com zero chamadas aqui, contra
// 147 do sync-agents no mesmo período. GET e POST chamam a mesma lógica; POST
// continua existindo para disparo manual/teste com o mesmo CRON_SECRET.
export async function GET(req: NextRequest): Promise<NextResponse> {
  return dispatchPendingJobs(req)
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return dispatchPendingJobs(req)
}

async function dispatchPendingJobs(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET não configurado' }, { status: 500 })
  }

  const auth = req.headers.get('Authorization') ?? ''
  if (!safeEqual(auth, `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const lockClient = await tryAcquireCronDispatchLock()
  if (!lockClient) {
    return NextResponse.json({ processed: 0, sent: 0, failed: 0, skipped: 'cron_already_running' })
  }

  try {
    return await runDispatchPendingJobs()
  } finally {
    await releaseCronDispatchLock(lockClient)
  }
}

async function runDispatchPendingJobs(): Promise<NextResponse> {
  const now = new Date()
  const staleProcessingBefore = new Date(now.getTime() - processingLeaseTimeoutMs())
  // Ordena por prioridade do lead (desc) para processar cartao_recusado antes de boleto/carrinho
  const pendingJobs = await db.transaction(async tx => {
    const stale = await tx.update(messageJobs).set({
      status: 'failed',
      error: 'Job ficou em processing além do lease; revisão manual necessária para evitar reenvio duplicado',
      processingStartedAt: null,
    }).where(and(
      eq(messageJobs.status, 'processing'),
      lte(messageJobs.processingStartedAt, staleProcessingBefore),
    )).returning({ id: messageJobs.id })
    if (stale.length > 0) {
      console.error('[cron] ALERTA: jobs processing órfãos sinalizados para revisão manual', { jobIds: stale.map(row => row.id) })
    }
    const rows = await tx
      .select({
        job: messageJobs,
        companyId: recoveryLeads.companyId,
        companySlug: companies.slug,
        metaPhoneNumberId: settings.metaPhoneNumberId,
        whatsappProvider: settings.whatsappProvider,
        availabilitySchedule: settings.availabilitySchedule,
        availabilityScheduleManual: settings.availabilityScheduleManual,
        nativeAvailabilitySchedule: nativeAvailabilitySchedules.schedule,
        leadPhone: recoveryLeads.phone,
        leadCreatedAt: recoveryLeads.createdAt,
        leadPriority: recoveryLeads.priority,
        checkBeforeSend: messageJobs.checkBeforeSend,
      })
      .from(messageJobs)
      .innerJoin(recoveryLeads, eq(messageJobs.leadId, recoveryLeads.id))
      .innerJoin(companies, eq(companies.id, recoveryLeads.companyId))
      .innerJoin(settings, eq(settings.companyId, recoveryLeads.companyId))
      .leftJoin(nativeAvailabilitySchedules, eq(nativeAvailabilitySchedules.companyId, recoveryLeads.companyId))
      .where(and(
        eq(messageJobs.status, 'pending'),
        lte(messageJobs.scheduledFor, now),
        sql`NOT EXISTS (
          SELECT 1
          FROM mass_dispatch_phone_cooldowns c
          WHERE c.meta_phone_number_id = ${settings.metaPhoneNumberId}
            AND c.cooldown_until > ${now}
        )`
      ))
      .orderBy(desc(recoveryLeads.priority))
      .limit(MAX_JOBS_PER_RUN)
      .for('update', { skipLocked: true })
    const ids = rows.map(row => row.job.id)
    if (ids.length > 0) {
      await tx.update(messageJobs).set({ status: 'processing', processingStartedAt: now }).where(inArray(messageJobs.id, ids))
    }
    return rows
  })

  const backlogEligibleRows = pendingJobs.filter(row => row.job.messageOrder != null && row.job.massDispatchBatchId == null)
  const selection = firstDueJobPerLead(backlogEligibleRows.map(row => ({
    id: row.job.id,
    leadId: row.job.leadId,
    messageOrder: row.job.messageOrder,
  })))
  const deferredBacklogIds = selection.defer.map(job => job.id)
  const deferredBacklogIdSet = new Set(deferredBacklogIds)
  if (deferredBacklogIds.length > 0) {
    await db.update(messageJobs).set({
      status: 'pending',
      error: 'Aguardando envio do passo anterior de follow-up',
      processingStartedAt: null,
    }).where(inArray(messageJobs.id, deferredBacklogIds))
  }
  const runnableJobs = pendingJobs.filter(row => !deferredBacklogIdSet.has(row.job.id))

  // Janela de 24h da Meta: precisa da última mensagem INBOUND de cada lead
  // do batch (sem isso, mensagem livre pra contato frio fora da janela é
  // recusada pela Meta, ou pior, aceita por engano em algum canal). Um único
  // round-trip pro batch inteiro, igual ao padrão de src/app/api/inbox/route.ts.
  const jobLeadIds = [...new Set(runnableJobs.map(p => p.job.leadId).filter((id): id is number => id != null))]
  const jobPhones = [...new Set(runnableJobs.map(p => p.leadPhone).filter((p): p is string => Boolean(p)))]
  const companyIds = [...new Set(runnableJobs.map(p => p.companyId))]

  const inboundMessages = jobLeadIds.length > 0
    ? await db
        .select({ leadId: whatsappMessages.leadId, phone: whatsappMessages.phone, createdAt: whatsappMessages.createdAt })
        .from(whatsappMessages)
        .where(and(
          eq(whatsappMessages.direction, 'inbound'),
          jobPhones.length > 0
            ? or(inArray(whatsappMessages.leadId, jobLeadIds), inArray(whatsappMessages.phone, jobPhones))!
            : inArray(whatsappMessages.leadId, jobLeadIds)
        ))
        .orderBy(desc(whatsappMessages.createdAt))
        .limit(500)
    : []

  const blockedRows = companyIds.length > 0
    ? await db
        .select({ companyId: agendaBlockedDates.companyId, date: agendaBlockedDates.date })
        .from(agendaBlockedDates)
        .where(inArray(agendaBlockedDates.companyId, companyIds))
    : []
  const blockedDatesByCompany = new Map<number, Set<string>>()
  for (const row of blockedRows) {
    const current = blockedDatesByCompany.get(row.companyId) ?? new Set<string>()
    current.add(row.date)
    blockedDatesByCompany.set(row.companyId, current)
  }

  const lastInboundByLead = new Map<number, Date>()
  const lastInboundByPhone = new Map<string, Date>()
  for (const m of inboundMessages) {
    if (m.leadId != null && m.createdAt && !lastInboundByLead.has(m.leadId)) lastInboundByLead.set(m.leadId, m.createdAt)
    if (m.phone && m.createdAt && !lastInboundByPhone.has(m.phone)) lastInboundByPhone.set(m.phone, m.createdAt)
  }

  function lastInboundFor(leadId: number | null | undefined, phone: string | null | undefined): Date | null {
    if (leadId != null && lastInboundByLead.has(leadId)) return lastInboundByLead.get(leadId)!
    if (phone && lastInboundByPhone.has(phone)) return lastInboundByPhone.get(phone)!
    return null
  }

  async function followupSpacingDecision(job: typeof messageJobs.$inferSelect): Promise<{ allowed: true } | { allowed: false; retryAt: Date; reason: string }> {
    if (job.massDispatchBatchId != null || job.messageOrder == null || job.leadId == null || job.messageId == null) {
      return { allowed: true }
    }

    const [currentMessage] = await db
      .select({
        sequenceId: sequenceMessages.sequenceId,
        order: sequenceMessages.order,
        delayMinutes: sequenceMessages.delayMinutes,
      })
      .from(sequenceMessages)
      .where(eq(sequenceMessages.id, job.messageId))
      .limit(1)

    if (!currentMessage || currentMessage.sequenceId == null) return { allowed: true }

    const [previousConfiguredStep] = await db
      .select({
        order: sequenceMessages.order,
        delayMinutes: sequenceMessages.delayMinutes,
      })
      .from(sequenceMessages)
      .where(and(
        eq(sequenceMessages.sequenceId, currentMessage.sequenceId),
        eq(sequenceMessages.isActive, true),
        sql`${sequenceMessages.order} < ${currentMessage.order}`,
      ))
      .orderBy(desc(sequenceMessages.order))
      .limit(1)

    if (!previousConfiguredStep) return { allowed: true }

    const [previousSentJob] = await db
      .select({
        sentAt: messageJobs.sentAt,
        messageId: messageJobs.messageId,
      })
      .from(messageJobs)
      .where(and(
        eq(messageJobs.leadId, job.leadId),
        inArray(messageJobs.status, ['sent', 'sent_unconfirmed']),
        sql`${messageJobs.messageOrder} < ${job.messageOrder}`,
      ))
      .orderBy(desc(messageJobs.messageOrder))
      .limit(1)

    if (!previousSentJob?.sentAt) {
      return {
        allowed: false,
        retryAt: new Date(now.getTime() + 5 * 60_000),
        reason: 'aguardando envio do passo anterior de follow-up',
      }
    }

    const [previousMessage] = previousSentJob.messageId
      ? await db
          .select({ delayMinutes: sequenceMessages.delayMinutes })
          .from(sequenceMessages)
          .where(eq(sequenceMessages.id, previousSentJob.messageId))
          .limit(1)
      : []

    const retryAt = retryAtAfterPreviousFollowupStep({
      previousSentAt: previousSentJob.sentAt,
      previousDelayMinutes: previousMessage?.delayMinutes ?? previousConfiguredStep.delayMinutes,
      currentDelayMinutes: currentMessage.delayMinutes,
      now,
    })

    return retryAt
      ? { allowed: false, retryAt, reason: 'aguardando intervalo entre passos de follow-up' }
      : { allowed: true }
  }

  let sent = 0
  let failed = 0
  let hasDispatchedAny = false
  const cooldownsByPhone = new Map<string, Date>()

  for (const { job, companyId, companySlug, metaPhoneNumberId, whatsappProvider, availabilitySchedule, availabilityScheduleManual, nativeAvailabilitySchedule, leadPhone, leadCreatedAt, checkBeforeSend } of runnableJobs) {
    let providerAccepted = false
    try {
      const activeCooldown = metaPhoneNumberId ? cooldownsByPhone.get(metaPhoneNumberId) : undefined
      if (activeCooldown && activeCooldown > new Date()) {
        await db.update(messageJobs).set({
          status: 'pending',
          scheduledFor: activeCooldown,
          error: 'Cooldown ativo para este número Meta após 429; job adiado sem nova chamada',
          processingStartedAt: null,
        }).where(eq(messageJobs.id, job.id))
        continue
      }

      if (!job.leadId || (!job.messageId && !job.upsellContent)) {
        await db.update(messageJobs).set({ status: 'failed', error: 'Missing lead or message', processingStartedAt: null }).where(eq(messageJobs.id, job.id))
        failed++
        continue
      }

      // Verificar se lead já comprou antes de enviar mensagem de recuperação
      if (checkBeforeSend && leadPhone && leadCreatedAt) {
        const [purchased] = await db
          .select({ id: recoveryLeads.id })
          .from(recoveryLeads)
          .where(and(
            eq(recoveryLeads.companyId, companyId),
            eq(recoveryLeads.phone, leadPhone),
            eq(recoveryLeads.eventType, 'compra_aprovada'),
            gt(recoveryLeads.createdAt, leadCreatedAt)
          ))
          .limit(1)

        if (purchased) {
          await db
            .update(messageJobs)
            .set({ status: 'cancelled', processingStartedAt: null })
            .where(and(
              eq(messageJobs.leadId, job.leadId),
              inArray(messageJobs.status, ['pending', 'processing'])
            ))
          // Fase 2: registra qual job/mensagem desencadeou a conversão
          await db
            .update(recoveryLeads)
            .set({
              status: 'converted',
              convertedByJobId: job.id,
              convertedFrom: job.messageOrder != null ? `msg_${job.messageOrder}` : null,
              updatedAt: new Date(),
            })
            .where(eq(recoveryLeads.id, job.leadId))
          continue
        }
      }

      const [lead] = await db.select().from(recoveryLeads).where(eq(recoveryLeads.id, job.leadId))
      if (!lead) {
        await db.update(messageJobs).set({ status: 'failed', error: 'Lead not found', processingStartedAt: null }).where(eq(messageJobs.id, job.id))
        failed++
        continue
      }
      if (lead.botPaused) {
        await db
          .update(messageJobs)
          .set({ status: 'cancelled', error: 'Lead com bot pausado antes do envio', processingStartedAt: null })
          .where(and(
            eq(messageJobs.leadId, job.leadId),
            inArray(messageJobs.status, ['pending', 'processing'])
          ))
        continue
      }

      const spacing = await followupSpacingDecision(job)
      if (!spacing.allowed) {
        await db.update(messageJobs).set({
          status: 'pending',
          scheduledFor: spacing.retryAt,
          error: `Adiado: ${spacing.reason}`,
          processingStartedAt: null,
        }).where(eq(messageJobs.id, job.id))
        continue
      }

      if (shouldApplyFollowupDispatchWindow(job)) {
        const storedSchedule = normalizeAvailabilitySchedule(availabilitySchedule)
        const nativeSchedule = normalizeAvailabilitySchedule(nativeAvailabilitySchedule)
        const nativeCompany = isNativeAvailabilityCompany(companySlug)
        const schedule = selectFollowupDispatchSchedule({
          storedSchedule,
          nativeSchedule,
          manualOverride: availabilityScheduleManual,
          manualWriteThroughAvailable: !nativeCompany || shouldSyncHermesAgenda(companySlug),
        })
        const dispatchWindow = evaluateDispatchWindow({
          schedule,
          blockedDates: blockedDatesByCompany.get(companyId) ?? new Set<string>(),
          now,
        })
        if (!dispatchWindow.allowed) {
          await db.update(messageJobs).set({
            status: 'pending',
            scheduledFor: dispatchWindow.retryAt ?? new Date(now.getTime() + 24 * 60 * 60_000),
            error: `Adiado: ${dispatchWindow.reason}`,
            processingStartedAt: null,
          }).where(eq(messageJobs.id, job.id))
          continue
        }
      }

      // Job de upsell: conteúdo direto, sem referência a sequenceMessages
      if (job.upsellContent) {
        if ((whatsappProvider ?? 'meta') === 'meta') {
          const upsellWindow = checkMetaWindowForJob({
            messageType: 'text',
            lastInboundAt: lastInboundFor(job.leadId, leadPhone),
          })
          if (!upsellWindow.allowed) {
            await db.update(messageJobs).set({
              status: 'failed',
              error: upsellWindow.error,
              processingStartedAt: null,
            }).where(eq(messageJobs.id, job.id))
            failed++
            continue
          }
        }

        if (hasDispatchedAny) {
          const spacingMs = calculateDispatchSpacingMs()
          if (spacingMs > 0) {
            await new Promise(resolve => setTimeout(resolve, spacingMs))
          }
        }
        hasDispatchedAny = true

        const outcome = await executeAndRecordDispatch(
          () => sendWhatsAppMessage(lead.phone, {
            type: 'text',
            content: interpolate(job.upsellContent, lead),
          }, companyId),
          result => recordJobOutcome(job.id, result, metaPhoneNumberId),
          undefined,
          result => recordJobOutcome(job.id, result, metaPhoneNumberId),
          job.retryCount,
        )
        if (outcome.status === 'rate_limited' && metaPhoneNumberId) cooldownsByPhone.set(metaPhoneNumberId, outcome.retryAt)
        providerAccepted = outcome.status === 'sent' || outcome.status === 'sent_unconfirmed'
        if (!providerAccepted) {
          if (outcome.status === 'failed') failed++
          continue
        }
        // Mensagem de verdade enviada: se for a primeira, marca a abordagem do lead
        await markLeadContacted(lead.id)
        sent++
        continue
      }

      let message: MessageSnapshot | undefined
      if (job.massDispatchBatchId != null) {
        // Segurança central do disparo em massa: nunca reler o template vivo.
        // Jobs legados sem snapshot falham fechados em vez de enviar conteúdo
        // que o usuário não aprovou no preview.
        message = job.messageSnapshot as MessageSnapshot | undefined
      } else {
        const [liveMessage] = await db.select().from(sequenceMessages).where(eq(sequenceMessages.id, job.messageId!))
        message = liveMessage ? {
          messageType: liveMessage.messageType ?? 'text',
          content: liveMessage.content,
          mediaUrl: liveMessage.mediaUrl,
          caption: liveMessage.caption,
          buttonsJson: liveMessage.buttonsJson,
          templateName: liveMessage.templateName,
          templateLanguage: liveMessage.templateLanguage,
          templateVariablesMap: liveMessage.templateVariablesMap,
        } : undefined
      }

      if (!message) {
        const error = job.massDispatchBatchId != null ? 'Missing immutable message snapshot' : 'Message not found'
        await db.update(messageJobs).set({ status: 'failed', error, processingStartedAt: null }).where(eq(messageJobs.id, job.id))
        failed++
        continue
      }

      const msgType = message.messageType ?? 'text'
      const buttons = Array.isArray(message.buttonsJson) ? message.buttonsJson as { id: string; label: string }[] : undefined

      if ((whatsappProvider ?? 'meta') === 'meta') {
        const windowCheck = checkMetaWindowForJob({
          messageType: msgType,
          templateName: message.templateName,
          lastInboundAt: lastInboundFor(job.leadId, leadPhone),
        })
        if (!windowCheck.allowed) {
          await db.update(messageJobs).set({
            status: 'failed',
            error: windowCheck.error,
            processingStartedAt: null,
          }).where(eq(messageJobs.id, job.id))
          failed++
          continue
        }
      }

      // Fase 1.3: monta variáveis interpoladas para templates Meta
      let templateVariableValues: string[] | undefined
      if (msgType === 'template' && message.templateVariablesMap) {
        const varMap = message.templateVariablesMap as Record<string, string>
        const maxIndex = Math.max(...Object.keys(varMap).map(Number).filter(n => !isNaN(n)), 0)
        templateVariableValues = Array.from({ length: maxIndex }, (_, i) => {
          const sysVar = varMap[String(i + 1)] ?? ''
          return interpolate(sysVar, lead)
        })
      }

      if (hasDispatchedAny) {
        const spacingMs = calculateDispatchSpacingMs()
        if (spacingMs > 0) {
          await new Promise(resolve => setTimeout(resolve, spacingMs))
        }
      }
      hasDispatchedAny = true

      const outcome = await executeAndRecordDispatch(
        () => sendWhatsAppMessage(lead.phone, {
          type: msgType,
          content: interpolate(message.content, lead),
          mediaUrl: message.mediaUrl ?? undefined,
          caption: interpolate(message.caption, lead),
          buttons,
          templateName: message.templateName ?? undefined,
          templateLanguage: message.templateLanguage ?? undefined,
          templateVariableValues,
        }, companyId),
        result => recordJobOutcome(job.id, result, metaPhoneNumberId),
        undefined,
        result => recordJobOutcome(job.id, result, metaPhoneNumberId),
        job.retryCount,
      )
      if (outcome.status === 'rate_limited' && metaPhoneNumberId) cooldownsByPhone.set(metaPhoneNumberId, outcome.retryAt)
      providerAccepted = outcome.status === 'sent' || outcome.status === 'sent_unconfirmed'
      if (!providerAccepted) {
        if (outcome.status === 'failed') failed++
        continue
      }
      await db.update(recoveryLeads).set({ status: 'in_progress', updatedAt: new Date() }).where(eq(recoveryLeads.id, lead.id))
      // Mensagem de verdade enviada: se for a primeira, marca a abordagem do lead
      await markLeadContacted(lead.id)
      sent++
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (providerAccepted) {
        console.error('[cron] ALERTA: falha pós-envio; job não será marcado como failed', { jobId: job.id, error: errorMsg })
        try {
          await db.update(messageJobs).set({ status: 'sent_unconfirmed', error: `Falha pós-envio: ${errorMsg}`, processingStartedAt: null }).where(eq(messageJobs.id, job.id))
        } catch (persistErr) {
          console.error('[cron] ALERTA CRÍTICO: falha ao persistir sent_unconfirmed', { jobId: job.id, persistErr })
        }
      } else {
        await db.update(messageJobs).set({ status: 'failed', error: errorMsg, processingStartedAt: null }).where(eq(messageJobs.id, job.id))
        failed++
      }
    }
  }

  // Marcar leads sem jobs pendentes como completed
  const completedLeadIds = new Set<number>()
  for (const { job } of runnableJobs) {
    if (job.leadId && !completedLeadIds.has(job.leadId)) {
      const remaining = await db.select().from(messageJobs)
        .where(and(eq(messageJobs.leadId, job.leadId), inArray(messageJobs.status, ['pending', 'processing'])))
      if (remaining.length === 0) {
        const [cur] = await db.select({ status: recoveryLeads.status }).from(recoveryLeads).where(eq(recoveryLeads.id, job.leadId))
        if (cur && cur.status !== 'converted') {
          await db.update(recoveryLeads).set({ status: 'completed', updatedAt: new Date() }).where(eq(recoveryLeads.id, job.leadId))
        }
        completedLeadIds.add(job.leadId)
      }
    }
  }

  // SAC Lote 1: Avaliar regras internas de pendência (retorno vencido, transbordo sem dono, etapa sem retorno)
  try {
    const activeCompanies = await db.select({ id: companies.id }).from(companies)
    for (const c of activeCompanies) {
      try { await evaluateSacPendingRules({ companyId: c.id }) }
      catch (error) { console.error('[cron] Falha ao reconciliar pendências SAC', { companyId: c.id, error }) }
    }
  } catch (error) {
    // Falhas em regras internas não interrompem o cron
    console.error('[cron] Falha ao listar empresas para pendências SAC', error)
  }

  return NextResponse.json({ processed: runnableJobs.length, sent, failed })
}
