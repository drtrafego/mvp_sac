/** Regras compartilhadas pelos webhooks de checkout. */

export function canScheduleAutomaticRecoverySequence(eventType: string): boolean {
  // Carrinho abandonado é apenas registro/estado. O SAC não inicia conversa
  // nem agenda mensagem automática nesse evento.
  return eventType !== 'carrinho_abandonado'
}

export type SequenceMessageForPolicy = {
  messageType?: string | null
  templateName?: string | null
}

/** A sequência da Isabela só aceita modelos UTILITY aprovados e sincronizados. */
export function isApprovedUtilitySequence(
  messages: SequenceMessageForPolicy[],
  approvedUtilityTemplateNames: ReadonlySet<string>,
): boolean {
  return messages.length > 0 && messages.every(message =>
    message.messageType === 'template'
    && Boolean(message.templateName)
    && approvedUtilityTemplateNames.has(message.templateName as string)
  )
}
