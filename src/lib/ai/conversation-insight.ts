import type { companies, recoveryLeads, settings, whatsappMessages } from '@/lib/db/schema'
import { gerarResposta, type Bot, type ResultadoBridge } from './ai-bridge'

type Company = typeof companies.$inferSelect
type Lead = typeof recoveryLeads.$inferSelect
type Settings = typeof settings.$inferSelect
type Message = Pick<typeof whatsappMessages.$inferSelect, 'id' | 'direction' | 'content' | 'messageType' | 'createdAt' | 'sendState' | 'externalId'>

export type AiInsight = {
  interpretation: string
  intent: string
  evidence: Array<{ label: string; value: string }>
  confidence: string
  state: 'interpreted' | 'blocked' | 'unavailable'
  proposedAction: string
  executedAction: string
  consent: string
  audit: string
  blockReason?: string
  source: 'conversation' | 'audio'
  transcript?: string
}

const BOT_BY_SLUG: Record<string, Bot> = {
  autonomia: 'nina',
  amanda: 'amanda',
  bela: 'bela',
  'isabela-fanini': 'bela',
  fanini: 'bela',
}

function safeText(value: string | null | undefined, max = 500): string {
  return (value || '').replace(/\u0000/g, '').trim().slice(0, max)
}

function actionLabel(action: { tipo?: string } | null | undefined): string {
  if (!action?.tipo) return 'Nenhuma ação externa proposta.'
  return ({
    book: 'Agendar reunião, sujeito à validação da agenda e revisão humana quando exigida.',
    reschedule: 'Remarcar reunião, sujeito à validação da agenda e revisão humana quando exigida.',
    cancel: 'Cancelar reunião, sujeito à confirmação e às regras do atendimento.',
  } as Record<string, string>)[action.tipo] || `Ação ${action.tipo} não reconhecida.`
}

function bridgeBlockReason(result: Extract<ResultadoBridge, { ok: false }>): string {
  if (result.motivo === 'sem_config') return 'Ponte de IA indisponível: AI_BRIDGE_URL e AI_BRIDGE_TOKEN precisam estar configurados no servidor/cofre.'
  if (result.motivo === 'auth') return 'Ponte de IA recusou a autenticação do servidor. Confira o cofre, sem trocar a chave pelo painel.'
  if (result.motivo === 'payload_invalido') return 'Ponte de IA recusou o formato da conversa.'
  if (result.motivo === 'rate_limit_local' || result.motivo === 'rate_limit_remoto') return 'Ponte de IA temporariamente limitada. Aguarde e tente interpretar novamente.'
  return 'Ponte de IA indisponível no momento. Nenhuma ação foi executada.'
}

export async function interpretConversation(input: {
  company: Company
  lead: Lead
  config?: Settings | null
  messages: Message[]
  transcript?: string | null
  source: 'conversation' | 'audio'
}): Promise<AiInsight> {
  const currentText = safeText(input.transcript) || safeText(input.messages.find(message => message.direction === 'inbound')?.content, 8_000)
  const bot = BOT_BY_SLUG[input.config?.aiAgentKey || input.company.slug]
  const evidence = [
    { label: 'Fonte', value: input.source === 'audio' ? 'Áudio preservado no SAC' : 'Mensagem recebida na conversa' },
    { label: 'Contexto', value: `${input.messages.length} evento(s) carregado(s)` },
    { label: 'Consentimento', value: 'Ação externa exige aprovação e permanece bloqueada nesta análise' },
  ]

  if (!currentText) {
    return {
      interpretation: 'Não há mensagem recebida suficiente para interpretar.',
      intent: 'Sem mensagem', evidence, confidence: 'Indisponível', state: 'blocked',
      proposedAction: 'Nenhuma ação proposta.', executedAction: 'Nenhuma ação executada.',
      consent: 'Não solicitado', audit: 'Análise bloqueada por falta de evidência.',
      blockReason: 'A conversa não possui texto ou transcrição disponível.', source: input.source,
    }
  }
  if (!bot) {
    return {
      interpretation: 'A empresa não possui agente de IA resolvido para esta conversa.',
      intent: 'Não classificada', evidence, confidence: 'Indisponível', state: 'blocked',
      proposedAction: 'Nenhuma ação proposta.', executedAction: 'Nenhuma ação executada.',
      consent: 'Não solicitado', audit: 'Bloqueio registrado na tela.',
      blockReason: 'Agente de IA da empresa não configurado.', source: input.source,
      ...(input.transcript ? { transcript: input.transcript } : {}),
    }
  }

  const history = input.messages
    .filter(message => message.direction === 'inbound' || (message.direction === 'outbound' && (message.sendState === 'accepted' || (message.sendState == null && !!message.externalId))))
    .slice(-12)
    .reverse()
    .map(message => ({ role: message.direction === 'inbound' ? 'lead' as const : 'bot' as const, text: safeText(message.content) || `[${message.messageType || 'mídia'}]` }))
  const result = await gerarResposta({
    bot,
    mensagem: currentText,
    historico: history.slice(0, -1),
    nomeContato: input.lead.name || '',
    waId: input.lead.phone,
  })

  if (!result.ok) {
    const reason = bridgeBlockReason(result)
    return {
      interpretation: 'A mensagem foi recebida, mas a ponte não devolveu uma interpretação.',
      intent: 'Não classificada', evidence, confidence: 'Indisponível', state: 'unavailable',
      proposedAction: 'Nenhuma ação proposta.', executedAction: 'Nenhuma ação executada.',
      consent: 'Não solicitado', audit: `Falha auditável: ${result.motivo}.`, blockReason: reason,
      source: input.source, ...(input.transcript ? { transcript: input.transcript } : {}),
    }
  }

  const envelope = result.resposta
  const action = envelope.acao_detectada
  const intent = action?.tipo === 'book' ? 'Agendamento' : action?.tipo === 'reschedule' ? 'Remarcação' : action?.tipo === 'cancel' ? 'Cancelamento' : envelope.status === 'sem_resposta' ? 'Sem resposta' : 'Atendimento geral'
  const interpretation = safeText(envelope.resposta, 2_000) || 'A ponte marcou a conversa como sem resposta.'
  evidence.push({ label: 'Resultado da ponte', value: envelope.status === 'ok' ? 'Interpretação recebida' : 'Sem resposta acionável' })
  if (action) evidence.push({ label: 'Ação detectada', value: action.tipo })
  return {
    interpretation,
    intent,
    evidence,
    confidence: 'Estado interpretado; a ponte não forneceu percentual de confiança.',
    state: 'interpreted',
    proposedAction: actionLabel(action),
    executedAction: 'Nenhuma ação executada. Esta tela exige revisão/consentimento antes de qualquer efeito.',
    consent: 'Não concedido para esta análise.',
    audit: action ? 'Interpretação e proposta registradas; execução permanece bloqueada.' : 'Interpretação registrada sem ação externa.',
    source: input.source,
    ...(input.transcript ? { transcript: input.transcript } : {}),
  }
}
