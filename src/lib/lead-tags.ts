// Normalização compartilhada entre as rotas de tags (POST e DELETE) e importação —
// ver src/lib/db/schema.ts (leadTags) pro contrato completo.

export const PESSOA_TAG = 'pessoa'
export const BOT_PAUSED_BY_TAG_PESSOA = 'tag:pessoa'
export const MAX_TAG_LENGTH = 50

export const VALID_SCOPES = ['whatsapp', 'instagram', 'email', 'mineracao'] as const
export type TagScopeChannel = typeof VALID_SCOPES[number] | null

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH)
}

export function validateTagScope(
  tag: string,
  scopeChannel?: string | null,
  leadChannel?: string | null
): { ok: boolean; scopeChannel: TagScopeChannel; error?: string } {
  const normalizedTag = normalizeTag(tag)
  
  // A tag especial "pessoa" NUNCA tem escopo de canal: sempre geral (NULL)
  if (normalizedTag === PESSOA_TAG) {
    return { ok: true, scopeChannel: null }
  }

  if (!scopeChannel || typeof scopeChannel !== 'string' || !scopeChannel.trim()) {
    return { ok: true, scopeChannel: null }
  }

  const normScope = scopeChannel.trim().toLowerCase() as TagScopeChannel
  if (!VALID_SCOPES.includes(normScope as typeof VALID_SCOPES[number])) {
    return {
      ok: false,
      scopeChannel: null,
      error: `Escopo de canal inválido: "${scopeChannel}". Valores permitidos: ${VALID_SCOPES.join(', ')}`,
    }
  }

  if (leadChannel && typeof leadChannel === 'string' && leadChannel.trim()) {
    const normLeadChan = leadChannel.trim().toLowerCase()
    if (normScope !== normLeadChan) {
      return {
        ok: false,
        scopeChannel: null,
        error: `O escopo de canal "${normScope}" é incompatível com o canal do lead ("${normLeadChan}").`,
      }
    }
  }

  return { ok: true, scopeChannel: normScope }
}
