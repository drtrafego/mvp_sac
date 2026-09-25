// Normalização compartilhada entre as duas rotas de tags (POST e DELETE) —
// ver src/lib/db/schema.ts (leadTags) pro contrato completo.

export const PESSOA_TAG = 'pessoa'
export const BOT_PAUSED_BY_TAG_PESSOA = 'tag:pessoa'
export const MAX_TAG_LENGTH = 50

export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().slice(0, MAX_TAG_LENGTH)
}
