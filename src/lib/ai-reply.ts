// Motor de resposta automática da IA (Nina/AutonomIA, Amanda). Chamado pelo
// webhook via `after()`, depois da mensagem inbound já estar gravada e da
// resposta HTTP do webhook já ter saído: nada aqui pode atrasar a Meta.
//
// Mudança de arquitetura (19/09/2026, ordem do Gastão): este SAC NÃO chama
// mais nenhuma API de IA direto. Ele pede o texto pronto pra ponte da Luana
// (`gerarResposta`, em lib/ai/ai-bridge.ts), que fala com o cérebro DE
// VERDADE da Nina/Amanda (o mesmo claude -p / SOUL que já atende em
// produção) e já aplica, do lado dela, as travas de conteúdo (vazamento,
// sinal interno etc. do receiver.py). Evita duplicar aquela lógica aqui.
//
// O que sobra pro SAC é o FLUXO: quando chamar (respeitar botPaused e o
// gate por empresa), pra quem enviar, o rate limit da NOSSA aplicação, e
// executar de verdade a ação de agenda que a ponte apenas detectar
// (`acao_detectada`) — a ponte só gera texto, nunca mexe na agenda sozinha.

import { and, or, isNull, isNotNull, eq, desc, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads, settings, whatsappMessages, companies } from '@/lib/db/schema'
import { gerarResposta } from '@/lib/ai/ai-bridge'
import { executarAcaoDetectada } from '@/lib/ai/agenda-actions'
import { detectarBotDoOutroLado } from '@/lib/ai/bot-detector'
import { sendOutboundForLead } from '@/lib/outbound-send'
import { createAiReplyHandler, type AiReplyDependencies } from '@/lib/ai/ai-reply-flow'

const productionDependencies: AiReplyDependencies = {
  async acquireLock(leadId) {
    const result = await db.execute<{ id: number }>(sql`
      UPDATE recovery_leads SET ai_reply_lock_at = now()
      WHERE id = ${leadId}
        AND (ai_reply_lock_at IS NULL OR ai_reply_lock_at < now() - interval '3 minutes')
      RETURNING id
    `)
    return result.rows.length > 0
  },
  async releaseLock(leadId) {
    await db.execute(sql`UPDATE recovery_leads SET ai_reply_lock_at = NULL WHERE id = ${leadId}`)
      .catch(() => console.warn('[AI Reply] lock será liberado por expiração', { leadId }))
  },
  async readLead(id) {
    const [lead] = await db.select().from(recoveryLeads).where(eq(recoveryLeads.id, id)).limit(1)
    return lead
  },
  async readConfig(companyId) {
    const [config] = await db.select().from(settings).where(eq(settings.companyId, companyId)).limit(1)
    return config
  },
  async readCompany(id) {
    const [company] = await db.select().from(companies).where(eq(companies.id, id)).limit(1)
    return company
  },
  async readHistory(companyId, leadId) {
    return db.select({ id: whatsappMessages.id, direction: whatsappMessages.direction, content: whatsappMessages.content, messageType: whatsappMessages.messageType, createdAt: whatsappMessages.createdAt, sendState: whatsappMessages.sendState, externalId: whatsappMessages.externalId })
      .from(whatsappMessages).where(and(eq(whatsappMessages.companyId, companyId), eq(whatsappMessages.leadId, leadId), or(
        eq(whatsappMessages.direction, 'inbound'),
        and(eq(whatsappMessages.direction, 'outbound'), or(eq(whatsappMessages.sendState, 'accepted'), and(isNull(whatsappMessages.sendState), isNotNull(whatsappMessages.externalId)))),
      )))
      .orderBy(desc(whatsappMessages.createdAt), desc(whatsappMessages.id)).limit(21)
  },
  async readIntent(companyId, requestId) {
    const [intent] = await db.select().from(whatsappMessages)
      .where(and(eq(whatsappMessages.companyId, companyId), eq(whatsappMessages.clientRequestId, requestId))).limit(1)
    return intent
  },
  async persistSchedule(lead, state) {
    await db.update(recoveryLeads).set({ aiScheduleState: state })
      .where(and(eq(recoveryLeads.id, lead.id), eq(recoveryLeads.companyId, lead.companyId)))
  },
  async pauseIfUnchanged(lead, version, reason) {
    const [paused] = await db.update(recoveryLeads).set({
      botPaused: true, botPausedAt: new Date(), botPausedBy: reason,
      botControlVersion: sql`coalesce(${recoveryLeads.botControlVersion}, 0) + 1`,
    }).where(and(
      eq(recoveryLeads.id, lead.id), eq(recoveryLeads.companyId, lead.companyId),
      sql`coalesce(${recoveryLeads.botControlVersion}, 0) = ${version}`,
      sql`coalesce(${recoveryLeads.botPaused}, false) = false`,
    )).returning()
    return paused
  },
  generate: gerarResposta,
  executeAction: executarAcaoDetectada,
  detectBot: detectarBotDoOutroLado,
  send: sendOutboundForLead,
}

/** Overrides inject real dependency boundaries in tests; production uses its existing bridge. */
export async function generateAndSendAiReply(leadId: number, overrides: Partial<AiReplyDependencies> = {}): Promise<void> {
  return createAiReplyHandler({ ...productionDependencies, ...overrides })(leadId)
}
