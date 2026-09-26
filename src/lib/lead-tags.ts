/**
 * Utilitários para normalização e validação de tags de leads no SAC.
 */

export const ALLOWED_TAG_SCOPES = ['whatsapp', 'instagram', 'email', 'mineracao'] as const
export type ScopeChannel = (typeof ALLOWED_TAG_SCOPES)[number] | null | undefined

/**
 * Normaliza o texto de uma tag: remove espaços nas pontas, substitui múltiplos espaços por um só
 * e converte para minúsculas.
 */
export function normalizeTag(rawTag: string | null | undefined): string {
  if (!rawTag) return ''
  return rawTag
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/**
 * Valida o escopo de canal da tag contra o canal real do lead.
 * Se scopeChannel for nulo ou vazio, a tag é "Geral" e pode ser aplicada a qualquer lead.
 */
export function validateTagScope(
  scopeChannel: string | null | undefined,
  leadChannel: string | null | undefined
): { valid: boolean; error?: string } {
  if (!scopeChannel || scopeChannel.trim() === '' || scopeChannel === 'null') {
    return { valid: true }
  }

  const normScope = scopeChannel.toLowerCase().trim()
  if (!ALLOWED_TAG_SCOPES.includes(normScope as any)) {
    return {
      valid: false,
      error: `Canal de escopo inválido "${scopeChannel}". Canais permitidos: ${ALLOWED_TAG_SCOPES.join(', ')}.`,
    }
  }

  const normLeadChan = (leadChannel || 'whatsapp').toLowerCase().trim()

  // Mapeamentos equivalentes (ex.: instagram_direct -> instagram)
  const leadCategory =
    normLeadChan.includes('insta') ? 'instagram' :
    normLeadChan.includes('email') ? 'email' :
    normLeadChan.includes('miner') ? 'mineracao' :
    'whatsapp'

  if (normScope !== leadCategory) {
    return {
      valid: false,
      error: `Tag restrita ao canal "${normScope}", mas este lead pertence ao canal "${leadCategory}".`,
    }
  }

  return { valid: true }
}
