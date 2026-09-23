export const AGENT_DISPLAY_NAME_MAX_LENGTH = 80

export function parseAgentDisplayName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('O nome do bot deve ser um texto.')

  const trimmed = value.trim()
  if (!trimmed) throw new Error('O nome do bot não pode ficar vazio.')
  if (trimmed.length > AGENT_DISPLAY_NAME_MAX_LENGTH) {
    throw new Error(`O nome do bot deve ter no máximo ${AGENT_DISPLAY_NAME_MAX_LENGTH} caracteres.`)
  }
  return trimmed
}
