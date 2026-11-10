import type { recoveryLeads, settings, companies, whatsappMessages } from '@/lib/db/schema'
import type { gerarResposta, Bot, HistoricoTurno } from './ai-bridge'
import type { executarAcaoDetectada, AiScheduleState } from './agenda-actions'
import type { detectarBotDoOutroLado } from './bot-detector'
import type { sendOutboundForLead } from '@/lib/outbound-send'
import { extractAudioMediaId } from '@/lib/whatsapp/audio-media'

type Lead = typeof recoveryLeads.$inferSelect
type Config = typeof settings.$inferSelect
type Company = typeof companies.$inferSelect
type Message = typeof whatsappMessages.$inferSelect
export type AiReplyHistoryRow = Pick<Message, 'id' | 'direction' | 'content' | 'messageType' | 'mediaUrl' | 'createdAt' | 'sendState' | 'externalId'>

/** The production handler and tests share this workflow. External effects are injected. */
export interface AiReplyDependencies {
  acquireLock(leadId: number): Promise<boolean>
  releaseLock(leadId: number): Promise<void>
  readLead(leadId: number): Promise<Lead | undefined>
  readConfig(companyId: number): Promise<Config | undefined>
  readCompany(companyId: number): Promise<Company | undefined>
  readHistory(companyId: number, leadId: number): Promise<AiReplyHistoryRow[]>
  readIntent(companyId: number, requestId: string): Promise<Message | undefined>
  persistInboundAudioTranscription?(companyId: number, messageId: number, transcription: string): Promise<void>
  persistSchedule(lead: Lead, state: AiScheduleState): Promise<void>
  schedulePortalTemplate?(lead: Lead, state: FunilCursosState): Promise<void>
  pauseIfUnchanged(lead: Lead, expectedVersion: number, reason: string): Promise<Lead | undefined>
  generate: typeof gerarResposta
  executeAction: typeof executarAcaoDetectada
  detectBot: typeof detectarBotDoOutroLado
  send: typeof sendOutboundForLead
  /** Best-effort, PII-free lifecycle audit for the AI decision chain. */
  audit?(input: {
    leadId: number
    companyId: number
    type: string
    referenceId?: string | null
    payload?: Record<string, unknown>
  }): Promise<void>
}

import {
  formatFunilCursosContext,
  evaluateFunilTransition,
  createInitialFunilCursosState,
  canOfferPortal,
  type FunilCursosState,
} from '@/lib/funnels/funil-cursos'

const BOT_POR_SLUG: Record<string, Bot> = {
  autonomia: 'nina',
  amanda: 'amanda',
  bela: 'bela',
  'isabela-fanini': 'bela',
  fanini: 'bela',
}
const textOf = (row: AiReplyHistoryRow) => row.content?.trim() ? row.content : `[${row.messageType || 'mídia'}]`

export function createAiReplyHandler(deps: AiReplyDependencies) {
  return async function generateAndSendAiReply(leadId: number): Promise<void> {
    let auditCompanyId: number | null = null
    const audit = async (input: Omit<Parameters<NonNullable<AiReplyDependencies['audit']>>[0], 'leadId' | 'companyId'>) => {
      if (!deps.audit || auditCompanyId === null) return
      try {
        await deps.audit({
          leadId,
          companyId: auditCompanyId,
          ...input,
        })
      } catch {
        // Audit must never turn a safe, already-guarded response into a retry.
        console.error('[AI Reply] auditoria da cadeia não foi registrada', { leadId, type: input.type })
      }
    }
    let locked = false
    try {
      locked = await deps.acquireLock(leadId)
      if (!locked) return
      const lead = await deps.readLead(leadId)
      if (!lead || lead.botPaused) return
      auditCompanyId = lead.companyId
      const version = lead.botControlVersion ?? 0
      let ownClosure: { version: number; reason: string } | undefined
      const controlAllowsEffects = async () => {
        const current = await deps.readLead(leadId)
        if (!current || current.companyId !== lead.companyId) return false
        if (ownClosure) return current.botPaused === true && current.botPausedBy === ownClosure.reason && (current.botControlVersion ?? 0) === ownClosure.version
        return !current.botPaused && (current.botControlVersion ?? 0) === version
      }
      const config = await deps.readConfig(lead.companyId)
      if (!config?.aiSystemPrompt) return
      const company = await deps.readCompany(lead.companyId)
      const bot = BOT_POR_SLUG[config.aiAgentKey || company?.slug || '']
      if (!bot) return
      const rows = (await deps.readHistory(lead.companyId, lead.id)).filter(row => row.direction === 'inbound' || (row.direction === 'outbound' && (row.sendState === 'accepted' || (row.sendState == null && !!row.externalId))))
      // A failed/uncertain outbound can be newer than the request; never treat it as inbound.
      const currentIndex = rows.findIndex(row => row.direction === 'inbound')
      if (currentIndex < 0) return
      const current = rows[currentIndex]
      const previous = rows.slice(currentIndex + 1).reverse()
      // Stable per inbound event: a failed notice is retried without regenerating or redoing an action.
      const requestId = `ai-reply:${lead.companyId}:${lead.id}:${current.id}`
      await audit({
        type: 'ai_reply_started',
        referenceId: String(current.id),
        payload: { inboundMessageId: current.id, requestId },
      })
      const existing = await deps.readIntent(lead.companyId, requestId)
      const senderName = bot === 'nina' ? 'Nina' : bot === 'bela' ? 'Bela' : 'Amanda'
      if (existing) {
        if (existing.sendState !== 'failed' || !existing.content) return
        const retry = await deps.send({
          companyId: lead.companyId, lead, content: existing.content, messageType: 'text',
          clientRequestId: requestId, sentBy: 'bot', senderName,
          agentId: bot, beforeTransport: controlAllowsEffects,
        })
        await audit({
          type: retry.ok ? 'ai_reply_sent' : 'ai_reply_send_failed',
          referenceId: String(existing.id),
          payload: { status: retry.status, sendState: retry.message?.sendState ?? null, retry: true },
        })
        return
      }
      const chronology = [...previous, current].map(row => ({ role: row.direction === 'inbound' ? 'lead' as const : 'bot' as const, text: textOf(row), createdAt: row.createdAt }))
      const detection = deps.detectBot(chronology)
      if (detection.bot) {
        await deps.pauseIfUnchanged(lead, version, 'Anti-loop (bot do outro lado detectado)')
        return
      }
      const state: AiScheduleState = (lead.aiScheduleState as AiScheduleState) || {}
      const isFunilCursos = bot === 'bela' || (state as Record<string, unknown>)?.funnel_name === 'funil_cursos'
      let currentFunnelState: FunilCursosState | undefined
      const audioMediaId = current.direction === 'inbound' && !current.content?.trim()
        ? extractAudioMediaId(current.mediaUrl)
        : null
      let outgoingMessage = audioMediaId ? '[áudio recebido]' : textOf(current)

      if (isFunilCursos) {
        const existingFunnel = (state as Record<string, unknown>)?.funnel_name === 'funil_cursos'
          ? (state as unknown as FunilCursosState)
          : createInitialFunilCursosState({
              transactionId: lead.transactionId || `lead_${lead.id}`,
              productName: lead.productName,
              approvedDate: lead.approvedDate,
            })

        currentFunnelState = evaluateFunilTransition(existingFunnel, textOf(current), {
          humanTakeover: lead.botPaused || Boolean(lead.humanOwnerMemberId),
        })

        // Áudios precisam manter o contrato exato da ponte, que pede a mídia
        // pelo id; os demais turnos continuam recebendo o contexto do funil.
        if (!audioMediaId) outgoingMessage = `${formatFunilCursosContext(currentFunnelState)}\n\n${textOf(current)}`
      }

      const history: HistoricoTurno[] = previous.map(row => ({ role: row.direction === 'inbound' ? 'lead' : 'bot', text: textOf(row) }))
      const generated = await deps.generate({
        bot,
        mensagem: outgoingMessage,
        historico: history,
        nomeContato: lead.name || '',
        waId: lead.phone,
        agendamentoAtual: currentFunnelState ? (currentFunnelState as unknown as Record<string, unknown>) : Object.keys(state).length ? state : null,
        ...(audioMediaId ? { audioMediaId, phoneNumberId: config.metaPhoneNumberId || undefined } : {}),
      })
      await audit({
        type: 'ai_reply_interpreted',
        referenceId: String(current.id),
        payload: {
          ok: generated.ok,
          status: generated.ok ? generated.resposta.status : 'error',
          failure: generated.ok ? null : generated.motivo,
          actionType: generated.ok ? generated.resposta.acao_detectada?.tipo ?? null : null,
        },
      })
      if (generated.ok && audioMediaId && generated.resposta.transcricao) {
        await deps.persistInboundAudioTranscription?.(lead.companyId, current.id, generated.resposta.transcricao)
      }
      if (!generated.ok || !await controlAllowsEffects()) return
      const envelope = generated.resposta
      if (envelope.status === 'sem_resposta') return
      let text = (envelope.resposta || '').trim()
      let nextState = currentFunnelState ? (currentFunnelState as unknown as AiScheduleState) : state
      if (envelope.acao_detectada) {
        await audit({
          type: 'ai_action_requested',
          referenceId: String(current.id),
          payload: { actionType: envelope.acao_detectada.tipo },
        })
        if (!await controlAllowsEffects()) return
        const action = await deps.executeAction({ acao: envelope.acao_detectada, textoVisivel: text, telefone: lead.phone, nomeContato: lead.name || '', state: nextState }, { beforeExternalEffect: controlAllowsEffects })
        text = action.textoVisivel
        nextState = action.novoState
        await audit({
          type: 'ai_action_result',
          referenceId: String(current.id),
          payload: {
            actionType: envelope.acao_detectada.tipo,
            stateChanged: JSON.stringify(nextState) !== JSON.stringify(state),
          },
        })
      }
      // An already confirmed external action survives a human pause and a failed notice.
      if (JSON.stringify(nextState) !== JSON.stringify(state)) await deps.persistSchedule(lead, nextState)
      if (currentFunnelState && canOfferPortal(currentFunnelState)) {
        await deps.schedulePortalTemplate?.(lead, currentFunnelState)
      }
      if (currentFunnelState?.stage === 'pausado' && await controlAllowsEffects()) {
        const reason = currentFunnelState.pause_reason || 'IA (funil pausado por pedido do usuário)'
        const closed = await deps.pauseIfUnchanged(lead, version, reason)
        if (closed) ownClosure = { version: closed.botControlVersion ?? 0, reason }
      }
      if (envelope.encerrar && await controlAllowsEffects()) {
        const reason = `IA (encerrou: ${envelope.encerrar.motivo || 'sem motivo informado'})`
        const closed = await deps.pauseIfUnchanged(lead, version, reason)
        if (closed) ownClosure = { version: closed.botControlVersion ?? 0, reason }
      }
      if (!text.trim()) return
      // Sender persists the notice before its final control guard. A blocked/failed notice
      // stays recoverable; it must not cause an agenda action to be executed again.
      const sent = await deps.send({
        companyId: lead.companyId, lead, content: text, messageType: 'text',
        clientRequestId: requestId, sentBy: 'bot', senderName,
        agentId: bot, beforeTransport: controlAllowsEffects,
      })
      await audit({
        type: sent.ok ? 'ai_reply_sent' : 'ai_reply_send_failed',
        referenceId: String(current.id),
        payload: { status: sent.status, sendState: sent.message?.sendState ?? null, retry: false },
      })
    } catch {
      console.error('[AI Reply] rodada interrompida; conferir estado e aviso no atendimento', { leadId })
    } finally {
      if (locked) await deps.releaseLock(leadId)
    }
  }
}
