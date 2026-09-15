import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { db } from '@/lib/db'
import { messageJobs, recoveryLeads, sequenceMessages } from '@/lib/db/schema'
import { eq, lte, and, gt, desc } from 'drizzle-orm'
import { sendWhatsAppMessage } from '@/lib/whatsapp'

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET não configurado' }, { status: 500 })
  }

  const auth = req.headers.get('Authorization') ?? ''
  if (!safeEqual(auth, `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const now = new Date()
  // Ordena por prioridade do lead (desc) para processar cartao_recusado antes de boleto/carrinho
  const pendingJobs = await db
    .select({
      job: messageJobs,
      companyId: recoveryLeads.companyId,
      leadPhone: recoveryLeads.phone,
      leadCreatedAt: recoveryLeads.createdAt,
      leadPriority: recoveryLeads.priority,
      checkBeforeSend: messageJobs.checkBeforeSend,
    })
    .from(messageJobs)
    .innerJoin(recoveryLeads, eq(messageJobs.leadId, recoveryLeads.id))
    .where(and(eq(messageJobs.status, 'pending'), lte(messageJobs.scheduledFor, now)))
    .orderBy(desc(recoveryLeads.priority))
    .limit(50)

  let sent = 0
  let failed = 0

  for (const { job, companyId, leadPhone, leadCreatedAt, checkBeforeSend } of pendingJobs) {
    try {
      if (!job.leadId || (!job.messageId && !job.upsellContent)) {
        await db.update(messageJobs).set({ status: 'failed', error: 'Missing lead or message' }).where(eq(messageJobs.id, job.id))
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
            .set({ status: 'cancelled' })
            .where(and(
              eq(messageJobs.leadId, job.leadId),
              eq(messageJobs.status, 'pending')
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
        await db.update(messageJobs).set({ status: 'failed', error: 'Lead not found' }).where(eq(messageJobs.id, job.id))
        failed++
        continue
      }

      // Job de upsell: conteúdo direto, sem referência a sequenceMessages
      if (job.upsellContent) {
        const wamid = await sendWhatsAppMessage(lead.phone, {
          type: 'text',
          content: interpolate(job.upsellContent, lead),
        }, companyId)
        await db.update(messageJobs).set({ status: 'sent', sentAt: new Date(), externalWamid: wamid, deliveryStatus: 'sent' }).where(eq(messageJobs.id, job.id))
        sent++
        continue
      }

      const [message] = await db.select().from(sequenceMessages).where(eq(sequenceMessages.id, job.messageId!))

      if (!message) {
        await db.update(messageJobs).set({ status: 'failed', error: 'Message not found' }).where(eq(messageJobs.id, job.id))
        failed++
        continue
      }

      const msgType = message.messageType ?? 'text'
      const buttons = Array.isArray(message.buttonsJson) ? message.buttonsJson as { id: string; label: string }[] : undefined

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

      const wamid = await sendWhatsAppMessage(lead.phone, {
        type: msgType,
        content: interpolate(message.content, lead),
        mediaUrl: message.mediaUrl ?? undefined,
        caption: interpolate(message.caption, lead),
        buttons,
        templateName: message.templateName ?? undefined,
        templateLanguage: message.templateLanguage ?? undefined,
        templateVariableValues,
      }, companyId)

      await db.update(messageJobs).set({
        status: 'sent',
        sentAt: new Date(),
        externalWamid: wamid,
        deliveryStatus: 'sent',
      }).where(eq(messageJobs.id, job.id))
      await db.update(recoveryLeads).set({ status: 'in_progress', updatedAt: new Date() }).where(eq(recoveryLeads.id, lead.id))
      sent++
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await db.update(messageJobs).set({ status: 'failed', error: errorMsg }).where(eq(messageJobs.id, job.id))
      failed++
    }
  }

  // Marcar leads sem jobs pendentes como completed
  const completedLeadIds = new Set<number>()
  for (const { job } of pendingJobs) {
    if (job.leadId && !completedLeadIds.has(job.leadId)) {
      const remaining = await db.select().from(messageJobs)
        .where(and(eq(messageJobs.leadId, job.leadId), eq(messageJobs.status, 'pending')))
      if (remaining.length === 0) {
        const [cur] = await db.select({ status: recoveryLeads.status }).from(recoveryLeads).where(eq(recoveryLeads.id, job.leadId))
        if (cur && cur.status !== 'converted') {
          await db.update(recoveryLeads).set({ status: 'completed', updatedAt: new Date() }).where(eq(recoveryLeads.id, job.leadId))
        }
        completedLeadIds.add(job.leadId)
      }
    }
  }

  return NextResponse.json({ processed: pendingJobs.length, sent, failed })
}
