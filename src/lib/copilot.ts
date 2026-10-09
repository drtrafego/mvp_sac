import { eq, and, desc, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages, sacApprovedReplies } from '@/lib/db/schema'

export interface CopilotSource {
  id?: number
  title: string
  type: 'approved_reply' | 'lead_context'
}

export interface CopilotDraftResult {
  draft: string
  sources: CopilotSource[]
  missingInfo: string[]
  contextType: 'approved_reply' | 'contextual_suggestion'
}

export interface GenerateCopilotDraftOptions {
  companyId: number
  leadId: number
  operatorDraft?: string
}

/**
 * Normaliza texto para correspondência simples de palavras-chave
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
}

/**
 * Copiloto no editor humano (SAC Seção 9.1 e Oportunidade 10).
 * Gera rascunho contextual com base no histórico da conversa e respostas aprovadas,
 * mantendo o texto atual do operador, sem envio automático e sem execução de ações externas.
 */
export async function generateCopilotDraft(
  options: GenerateCopilotDraftOptions
): Promise<CopilotDraftResult> {
  const { companyId, leadId, operatorDraft = '' } = options

  // 1. Carrega lead com validação de escopo de empresa
  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, leadId), eq(recoveryLeads.companyId, companyId)))
    .limit(1)

  if (!lead) {
    throw new Error('Lead não encontrado para a empresa.')
  }

  // 2. Carrega mensagens recentes da conversa (até 10 mensagens)
  const messages = await db
    .select({
      id: whatsappMessages.id,
      direction: whatsappMessages.direction,
      content: whatsappMessages.content,
      createdAt: whatsappMessages.createdAt,
    })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.companyId, companyId),
        eq(whatsappMessages.leadId, leadId)
      )
    )
    .orderBy(desc(whatsappMessages.createdAt))
    .limit(10)

  const reversed = [...messages].reverse()
  const lastInbound = [...reversed].reverse().find((m) => m.direction === 'inbound')
  const clientText = lastInbound?.content?.trim() || ''

  // 3. Carrega respostas aprovadas da empresa
  const approvedList = await db
    .select()
    .from(sacApprovedReplies)
    .where(
      and(
        eq(sacApprovedReplies.companyId, companyId),
        eq(sacApprovedReplies.approvalState, 'approved')
      )
    )

  const leadName = lead.name?.trim() || 'Cliente'
  const productName = lead.productName?.trim() || ''

  // 4. Busca correspondência em Respostas Aprovadas
  const searchBasis = (operatorDraft ? `${operatorDraft} ` : '') + clientText
  const searchTokens = tokenize(searchBasis)

  let bestMatch: typeof approvedList[0] | null = null
  let maxScore = 0

  for (const reply of approvedList) {
    const replyTokens = tokenize(`${reply.title} ${reply.body}`)
    let score = 0
    for (const token of searchTokens) {
      if (replyTokens.includes(token)) score++
    }
    if (score > maxScore) {
      maxScore = score
      bestMatch = reply
    }
  }

  const missingInfo: string[] = []

  // Se encontrou resposta aprovada com aderência
  if (bestMatch && maxScore > 0) {
    let replacedText = bestMatch.body
      .replace(/\{nome\}/gi, leadName)
      .replace(/\{name\}/gi, leadName)

    if (productName) {
      replacedText = replacedText
        .replace(/\{produto\}/gi, productName)
        .replace(/\{product\}/gi, productName)
    }

    // Detecta variáveis pendentes que não foram substituídas (ex.: {produto}, {chave_pix}, {horario})
    const remainingVars = replacedText.match(/\{([a-zA-Z0-9_]+)\}/g)
    if (remainingVars) {
      for (const v of remainingVars) {
        if (!missingInfo.includes(v)) {
          missingInfo.push(v)
        }
      }
    }

    return {
      draft: replacedText,
      sources: [
        {
          id: bestMatch.id,
          title: bestMatch.title,
          type: 'approved_reply',
        },
      ],
      missingInfo,
      contextType: 'approved_reply',
    }
  }

  // 5. Sugestão contextual baseada nos dados do lead e compromisso
  let contextualDraft = ''
  const sources: CopilotSource[] = []
  const productPlaceholder = productName || '{produto}'

  if (lead.commitment && lead.nextAction) {
    contextualDraft = `Olá, ${leadName}! Conforme combinamos (${lead.commitment}), estou entrando em contato sobre ${lead.nextAction}. Como podemos te ajudar agora?`
    sources.push({
      title: `Compromisso registrado: ${lead.commitment}`,
      type: 'lead_context',
    })
  } else if (clientText.toLowerCase().includes('dificuldade') || clientText.toLowerCase().includes('ajuda') || clientText.toLowerCase().includes('acesso')) {
    contextualDraft = `Olá, ${leadName}! Vi que você mencionou uma dificuldade. Conte comigo para resolver isso agora! O que exatamente está acontecendo com seu acesso ao ${productPlaceholder}?`
    sources.push({
      title: 'Contexto de Suporte e Acesso',
      type: 'lead_context',
    })
  } else if (clientText.toLowerCase().includes('portal') || clientText.toLowerCase().includes('continuar')) {
    contextualDraft = `Olá, ${leadName}! Que maravilha ver seu interesse em continuar evoluindo no ${productPlaceholder}! Me conta, você gostaria de conhecer os detalhes da próxima etapa?`
    sources.push({
      title: 'Contexto de Continuidade e Atendimento',
      type: 'lead_context',
    })
  } else {
    contextualDraft = `Olá, ${leadName}! Tudo bem? Vi sua mensagem recente e estou aqui para te apoiar no ${productPlaceholder}. Como posso te ajudar hoje?`
    sources.push({
      title: 'Contexto Geral do Atendimento',
      type: 'lead_context',
    })
  }

  // Detecta variáveis pendentes na sugestão contextual (ex.: {produto})
  const remainingContextualVars = contextualDraft.match(/\{([a-zA-Z0-9_]+)\}/g)
  if (remainingContextualVars) {
    for (const v of remainingContextualVars) {
      if (!missingInfo.includes(v)) {
        missingInfo.push(v)
      }
    }
  }

  return {
    draft: contextualDraft,
    sources,
    missingInfo,
    contextType: 'contextual_suggestion',
  }
}
