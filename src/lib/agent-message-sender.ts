/**
 * Quem falou, para uma mensagem espelhada do banco do agente no SAC.
 *
 * Gramado Plaza: o dono do restaurante responde pelo celular e o script
 * `sync_atendente_humano.py` da ponte grava a fala dele no histórico da Gabi
 * com o prefixo literal "[atendente do restaurante] ", sempre com role
 * 'assistant'. Sem este rótulo o SAC mostrava a fala de uma PESSOA como "bot"
 * (balão com o nome da Gabi), e quem lia a conversa concluía que a IA tinha
 * dito aquilo.
 *
 * Só a role 'assistant' do schema `gramadoplazza` com o prefixo exato vira
 * 'human'. O texto NÃO é alterado (o prefixo continua no conteúdo): ele é a
 * chave de leitura do backfill e não muda hash nem deduplicação. Os demais
 * agentes e mensagens seguem exatamente como antes.
 */
export const GABI_HUMAN_PREFIX = '[atendente do restaurante]'

export type AgentMessageSender = 'user' | 'bot' | 'human'

export function senderForAgentMessage(input: {
  schema: string
  role: string | null | undefined
  content: string | null | undefined
}): AgentMessageSender {
  if (input.role === 'user') return 'user'
  if (
    input.schema === 'gramadoplazza' &&
    input.role === 'assistant' &&
    (input.content ?? '').trimStart().toLowerCase().startsWith(GABI_HUMAN_PREFIX)
  ) {
    return 'human'
  }
  return 'bot'
}
