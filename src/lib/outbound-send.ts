import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { sendInstagramMessage } from '@/lib/instagram'
import { sendBrevoEmail } from '@/lib/email/brevo'
import { markLeadContacted } from '@/lib/leads'
import { resolveLeadDeliveryChannel } from '@/lib/lead-delivery-channel'
import { eq, and } from 'drizzle-orm'

export interface OutboundSendInput {
  companyId: number
  lead: typeof recoveryLeads.$inferSelect
  content?: string | null
  mediaUrl?: string | null
  messageType?: string | null
  clientRequestId?: string | null
  sentBy?: 'human' | 'bot' | 'system'
  senderName?: string | null
  agentId?: string | null
  subject?: string | null
}

export interface OutboundSendResult {
  ok: boolean
  status: 200 | 202 | 502
  message: typeof whatsappMessages.$inferSelect | null
  error?: string
  isTimeout?: boolean
  idempotentReplay?: boolean
}

/**
 * Envio outbound unificado com rastreamento real de transporte, idempotência e recuperação.
 * (SAC Lote 1, item 5.1 e aceite A01).
 *
 * Contrato:
 * - 200: Aceito pelo transporte externo (Instagram/Brevo/WhatsApp).
 * - 502: Falha confirmada pelo transporte. Mensagem gravada no banco com sendState='failed'
 *        e sendError, garantindo histórico e recuperação do texto para retry.
 * - 202: Incerteza/timeout do transporte. Gravada como sendState='uncertain' para não
 *        repetir cegamente e evitar reenvio duplicado.
 */
export async function sendOutboundForLead(input: OutboundSendInput): Promise<OutboundSendResult> {
  const {
    companyId,
    lead,
    content = '',
    mediaUrl,
    messageType = 'text',
    clientRequestId,
    sentBy = 'human',
    senderName,
    agentId,
    subject,
  } = input

  const textContent = content ?? ''
  if (!textContent.trim() && !mediaUrl) {
    return {
      ok: false,
      status: 502,
      message: null,
      error: 'Mensagem vazia: informe texto ou mídia para envio.',
    }
  }

  // 1. Idempotência por clientRequestId (duplo clique, retry do navegador ou requisições concorrentes)
  if (clientRequestId) {
    const [existing] = await db
      .select()
      .from(whatsappMessages)
      .where(
        and(
          eq(whatsappMessages.companyId, companyId),
          eq(whatsappMessages.clientRequestId, clientRequestId),
        ),
      )
      .limit(1)

    if (existing) {
      if (existing.sendState === 'accepted') {
        return {
          ok: true,
          status: 200,
          message: existing,
          idempotentReplay: true,
        }
      }
      if (existing.sendState === 'uncertain') {
        return {
          ok: false,
          status: 202,
          message: existing,
          error: existing.sendError || 'Envio anterior sob reconciliação (timeout). Evite repetição imediata.',
          isTimeout: true,
          idempotentReplay: true,
        }
      }
      // Se era 'failed' ou 'pending', podemos tentar atualizar ou registrar novo intento
    }
  }

  const deliveryChannel = resolveLeadDeliveryChannel(lead)

  // 2. Gravar intento inicial (sendState = 'pending')
  let msgRow: typeof whatsappMessages.$inferSelect
  try {
    const [created] = await db
      .insert(whatsappMessages)
      .values({
        companyId,
        leadId: lead.id,
        phone: lead.phone,
        channel: deliveryChannel,
        direction: 'outbound',
        content: textContent || null,
        messageType: messageType || 'text',
        mediaUrl: mediaUrl || null,
        sentBy,
        senderName: senderName || null,
        agentId: agentId || null,
        clientRequestId: clientRequestId || null,
        sendState: 'pending',
      })
      .returning()
    msgRow = created
  } catch (err: any) {
    // Se colidiu no uniqueIndex de clientRequestId por concorrência simultânea
    if (clientRequestId && (err?.code === '23505' || String(err).includes('unique'))) {
      const [collided] = await db
        .select()
        .from(whatsappMessages)
        .where(
          and(
            eq(whatsappMessages.companyId, companyId),
            eq(whatsappMessages.clientRequestId, clientRequestId),
          ),
        )
        .limit(1)
      if (collided) {
        return {
          ok: collided.sendState === 'accepted',
          status: collided.sendState === 'accepted' ? 200 : (collided.sendState === 'uncertain' ? 202 : 502),
          message: collided,
          error: collided.sendError || undefined,
          idempotentReplay: true,
        }
      }
    }
    throw err
  }

  // 3. Execução do transporte com captura de erro real
  let externalId: string | null = null

  if (deliveryChannel === 'instagram') {
    try {
      const igRes = await sendInstagramMessage({
        recipientId: lead.phone,
        text: textContent,
        mediaUrl: mediaUrl || undefined,
        companyId,
      })
      if (!igRes.ok) {
        const errMsg = igRes.error || 'Falha ao enviar mensagem via Instagram Direct'
        const [failedRow] = await db
          .update(whatsappMessages)
          .set({
            sendState: 'failed',
            sendError: errMsg,
          })
          .where(eq(whatsappMessages.id, msgRow.id))
          .returning()

        return {
          ok: false,
          status: 502,
          message: failedRow,
          error: errMsg,
        }
      }
      externalId = igRes.messageId ?? null
    } catch (igErr: any) {
      const errMsg = igErr instanceof Error ? igErr.message : String(igErr)
      const [failedRow] = await db
        .update(whatsappMessages)
        .set({
          sendState: 'failed',
          sendError: errMsg,
        })
        .where(eq(whatsappMessages.id, msgRow.id))
        .returning()

      return {
        ok: false,
        status: 502,
        message: failedRow,
        error: errMsg,
      }
    }
  } else if (deliveryChannel === 'email' && lead.email) {
    try {
      const emailRes = await sendBrevoEmail({
        to: [{ email: lead.email, name: lead.name || undefined }],
        subject: subject || `Re: Atendimento - ${lead.productName || 'SAC'}`,
        htmlContent: `<p>${textContent.replace(/\n/g, '<br/>')}</p>`,
        textContent: textContent,
        companyId,
      })
      if (!emailRes.ok) {
        const errMsg = emailRes.error || 'Falha ao enviar e-mail via Brevo'
        const [failedRow] = await db
          .update(whatsappMessages)
          .set({
            sendState: 'failed',
            sendError: errMsg,
          })
          .where(eq(whatsappMessages.id, msgRow.id))
          .returning()

        return {
          ok: false,
          status: 502,
          message: failedRow,
          error: errMsg,
        }
      }
    } catch (emErr: any) {
      const errMsg = emErr instanceof Error ? emErr.message : String(emErr)
      const [failedRow] = await db
        .update(whatsappMessages)
        .set({
          sendState: 'failed',
          sendError: errMsg,
        })
        .where(eq(whatsappMessages.id, msgRow.id))
        .returning()

      return {
        ok: false,
        status: 502,
        message: failedRow,
        error: errMsg,
      }
    }
  } else {
    // WhatsApp (Meta Cloud API ou UazAPI)
    try {
      externalId = await sendWhatsAppMessage(
        lead.phone,
        {
          type: (messageType ?? 'text') as any,
          content: textContent,
          mediaUrl: mediaUrl || undefined,
        },
        companyId,
      )
    } catch (waErr: any) {
      const errorMsg = waErr instanceof Error ? waErr.message : String(waErr)
      const isTimeout =
        waErr?.name === 'AbortError' ||
        waErr?.code === 'ETIMEDOUT' ||
        errorMsg.toLowerCase().includes('timeout') ||
        errorMsg.toLowerCase().includes('aborterror')

      const finalState = isTimeout ? 'uncertain' : 'failed'
      const [updatedRow] = await db
        .update(whatsappMessages)
        .set({
          sendState: finalState,
          sendError: errorMsg,
        })
        .where(eq(whatsappMessages.id, msgRow.id))
        .returning()

      return {
        ok: false,
        status: isTimeout ? 202 : 502,
        message: updatedRow,
        error: errorMsg,
        isTimeout,
      }
    }
  }

  // 4. Sucesso: marcar como aceito e atualizar histórico do lead
  const [acceptedRow] = await db
    .update(whatsappMessages)
    .set({
      sendState: 'accepted',
      externalId,
    })
    .where(eq(whatsappMessages.id, msgRow.id))
    .returning()

  await markLeadContacted(lead.id)

  await db
    .update(recoveryLeads)
    .set({ updatedAt: new Date(), lastActionAt: new Date() })
    .where(eq(recoveryLeads.id, lead.id))

  return {
    ok: true,
    status: 200,
    message: acceptedRow,
  }
}
