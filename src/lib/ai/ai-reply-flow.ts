import type { recoveryLeads, settings, companies, whatsappMessages } from '@/lib/db/schema'
import type { gerarResposta, Bot, HistoricoTurno } from './ai-bridge'
import type { executarAcaoDetectada, AiScheduleState } from './agenda-actions'
import type { detectarBotDoOutroLado } from './bot-detector'
import type { sendOutboundForLead } from '@/lib/outbound-send'

type Lead = typeof recoveryLeads.$inferSelect
type Config = typeof settings.$inferSelect
type Company = typeof companies.$inferSelect
type Message = typeof whatsappMessages.$inferSelect
export type AiReplyHistoryRow = Pick<Message, 'id' | 'direction' | 'content' | 'messageType' | 'createdAt' | 'sendState' | 'externalId'>

/** The production handler and tests share this workflow. External effects are injected. */
export interface AiReplyDependencies {
  acquireLock(leadId: number): Promise<boolean>
  releaseLock(leadId: number): Promise<void>
  readLead(leadId: number): Promise<Lead | undefined>
  readConfig(companyId: number): Promise<Config | undefined>
  readCompany(companyId: number): Promise<Company | undefined>
  readHistory(companyId: number, leadId: number): Promise<AiReplyHistoryRow[]>
  readIntent(companyId: number, requestId: string): Promise<Message | undefined>
  persistSchedule(lead: Lead, state: AiScheduleState): Promise<void>
  pauseIfUnchanged(lead: Lead, expectedVersion: number, reason: string): Promise<Lead | undefined>
  generate: typeof gerarResposta
  executeAction: typeof executarAcaoDetectada
  detectBot: typeof detectarBotDoOutroLado
  send: typeof sendOutboundForLead
}

import {
  formatFunilCursosContext,
  evaluateFunilTransition,
  createInitialFunilCursosState,
  type FunilCursosState,
} from '@/lib/funnels/funil-cursos'

const BOT_POR_SLUG: Record<string, Bot> = {
  autonomia: 'nina',
  amanda: 'amanda',
  'isabela-fanini': 'bela',
  fanini: 'bela',
}
const textOf = (row: AiReplyHistoryRow) => row.content?.trim() ? row.content : `[${row.messageType || 'mídia'}]`

export function createAiReplyHandler(deps: AiReplyDependencies) {
  return async function generateAndSendAiReply(leadId: number): Promise<void> {
    let locked = false
    try {
      locked = await deps.acquireLock(leadId)
      if (!locked) return
      const lead = await deps.readLead(leadId)
      if (!lead || lead.botPaused) return
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
      const existing = await deps.readIntent(lead.companyId, requestId)
      const senderName = bot === 'nina' ? 'Nina' : bot === 'bela' ? 'Bela' : 'Amanda'
      if (existing) {
        if (existing.sendState !== 'failed' || !existing.content) return
        await deps.send({
          companyId: lead.companyId, lead, content: existing.content, messageType: 'text',
          clientRequestId: requestId, sentBy: 'bot', senderName,
          agentId: bot, beforeTransport: controlAllowsEffects,
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
      let outgoingMessage = textOf(current)

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

        // Injeta [FUNIL_CURSOS] antes de cada resposta conforme especificação
        outgoingMessage = `${formatFunilCursosContext(currentFunnelState)}\n\n${textOf(current)}`
      }

      const history: HistoricoTurno[] = previous.map(row => ({ role: row.direction === 'inbound' ? 'lead' : 'bot', text: textOf(row) }))
      const generated = await deps.generate({
        bot,
        mensagem: outgoingMessage,
        historico: history,
        nomeContato: lead.name || '',
        waId: lead.phone,
        agendamentoAtual: currentFunnelState ? (currentFunnelState as unknown as Record<string, unknown>) : Object.keys(state).length ? state : null,
      })
      if (!generated.ok || !await controlAllowsEffects()) return
      const envelope = generated.resposta
      if (envelope.status === 'sem_resposta') return
      let text = (envelope.resposta || '').trim()
      let nextState = currentFunnelState ? (currentFunnelState as unknown as AiScheduleState) : state
      if (envelope.acao_detectada) {
        if (!await controlAllowsEffects()) return
        const action = await deps.executeAction({ acao: envelope.acao_detectada, textoVisivel: text, telefone: lead.phone, nomeContato: lead.name || '', state: nextState }, { beforeExternalEffect: controlAllowsEffects })
        text = action.textoVisivel
        nextState = action.novoState
      }
      // An already confirmed external action survives a human pause and a failed notice.
      if (JSON.stringify(nextState) !== JSON.stringify(state)) await deps.persistSchedule(lead, nextState)
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
      await deps.send({
        companyId: lead.companyId, lead, content: text, messageType: 'text',
        clientRequestId: requestId, sentBy: 'bot', senderName,
        agentId: bot, beforeTransport: controlAllowsEffects,
      })
    } catch {
      console.error('[AI Reply] rodada interrompida; conferir estado e aviso no atendimento', { leadId })
    } finally {
      if (locked) await deps.releaseLock(leadId)
    }
  }
}
