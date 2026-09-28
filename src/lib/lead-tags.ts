// Normalização compartilhada entre as duas rotas de tags (POST e DELETE) —
// ver src/lib/db/schema.ts (leadTags) pro contrato completo.

export const PESSOA_TAG = 'pessoa'
export const BOT_PAUSED_BY_TAG_PESSOA = 'tag:pessoa'
export const MAX_TAG_LENGTH = 50

// Mesmo conjunto documentado em recoveryLeads.channel (schema.ts). Mantido
// aqui para que todas as entradas de tags validem o escopo do mesmo jeito.
export const LEAD_CHANNELS = ['whatsapp', 'instagram', 'email', 'mineracao'] as const
export type LeadChannel = (typeof LEAD_CHANNELS)[number]

export function isLeadChannel(value: unknown): value is LeadChannel {
  return typeof value === 'string' && LEAD_CHANNELS.includes(value as LeadChannel)
}

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH)
}

export function buildLeadTagDeleteUrl(
  leadId: number,
  tag: string,
  scopeChannel: LeadChannel | null | undefined,
): string {
  const base = `/api/leads/${leadId}/tags/${encodeURIComponent(tag)}`
  return scopeChannel == null
    ? base
    : `${base}?scopeChannel=${encodeURIComponent(scopeChannel)}`
}
