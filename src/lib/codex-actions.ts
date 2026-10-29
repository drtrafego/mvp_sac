import { createHash } from 'node:crypto'

export const CODEX_ACTION_MAX_TEXT = 20_000
export const CODEX_ACTION_MAX_AUDIO_BYTES = 25 * 1024 * 1024
export const CODEX_ACTION_ALLOWED_AUDIO_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'video/webm',
])

export const CODEX_ACTION_STATUSES = [
  'recebido',
  'avaliando',
  'aguardando_confirmacao',
  'executando',
  'concluido',
  'erro',
] as const

export type CodexActionStatus = typeof CODEX_ACTION_STATUSES[number]
export type CodexActionIntent = 'instagram.comment.create' | 'instagram.comment.reply' | 'generic.request'

// Operações externas explícitas que o executor SAC pode publicar neste
// contrato. Avaliação genérica pode continuar existindo no gateway, mas nunca
// ganha permissão de escrita por isso.
export const CODEX_ACTION_ALLOWLIST = ['instagram.comment.create', 'instagram.comment.reply'] as const

export function isAllowlistedCodexIntent(intent: CodexActionIntent | string): boolean {
  return (CODEX_ACTION_ALLOWLIST as readonly string[]).includes(intent)
}

export type CodexActionRequest = {
  transcript: string
  intent: CodexActionIntent
  targetText: string | null
  mediaId: string | null
  mediaUrl: string | null
  sessionId: string
  context: Record<string, string>
}

export type ParsedCodexIntent = Pick<CodexActionRequest, 'intent' | 'targetText' | 'mediaId' | 'mediaUrl'>

const SECRET_MARKERS = [
  /bearer\s+[a-z0-9._~-]{12,}/i,
  /(?:api[_ -]?key|access[_ -]?token|secret|password|senha)\s*[:=]/i,
  /-----begin [a-z ]+ key-----/i,
]

export function normalizeActionText(value: unknown, max = CODEX_ACTION_MAX_TEXT): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\u0000/g, '').trim().slice(0, max)
}

export function containsSecretLikeText(value: string): boolean {
  return SECRET_MARKERS.some(pattern => pattern.test(value))
}

export function safeActionContext(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const allowed = new Set(['surface', 'channel', 'conversationId', 'leadId', 'locale'])
  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key) || typeof raw !== 'string') continue
    const normalized = normalizeActionText(raw, 200)
    if (normalized && !containsSecretLikeText(normalized)) result[key] = normalized
  }
  return result
}

export function parseCodexIntent(transcript: string, context: Record<string, unknown> = {}): ParsedCodexIntent {
  const text = normalizeActionText(transcript)
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

  const isInstagramComment = /\b(instagram|coment[aá]rio)\b/.test(normalized)
    && /\b(crie|criar|publique|publicar|escreva|escrever|faca|fazer|responda|responder)\b/.test(normalized)

  if (!isInstagramComment) {
    return { intent: 'generic.request', targetText: null, mediaId: null, mediaUrl: null }
  }

  const mediaId = typeof context.mediaId === 'string' && /^\d+$/.test(context.mediaId.trim())
    ? context.mediaId.trim()
    : (text.match(/\b(?:media[_ -]?id|post|reel)\s*[:#]?\s*([0-9]{5,})\b/i)?.[1] ?? null)
  const mediaUrl = typeof context.mediaUrl === 'string' && /^https:\/\//i.test(context.mediaUrl.trim())
    ? context.mediaUrl.trim()
    : (text.match(/https:\/\/[^\s]+/i)?.[0]?.replace(/[),.;]+$/, '') ?? null)

  const targetMatch = text.match(/(?:coment[aá]rio|escreva|publique|crie)[^:\n]{0,100}[:\n]\s*["“']?(.+?)["”']?$/i)
  const targetText = normalizeActionText(targetMatch?.[1] ?? '', 2_000) || null

  return { intent: 'instagram.comment.create', targetText, mediaId, mediaUrl }
}

export function stableCodexIdempotencyKey(companyId: number, sessionId: string, transcript: string, mediaId: string | null, targetText: string | null): string {
  const source = [companyId, normalizeActionText(sessionId, 200), normalizeActionText(transcript), mediaId ?? '', targetText ?? ''].join('|')
  return createHash('sha256').update(source).digest('hex')
}

export function validateAudioUpload(size: number, mimeType: string): string | null {
  if (!Number.isSafeInteger(size) || size <= 0) return 'O áudio está vazio.'
  if (size > CODEX_ACTION_MAX_AUDIO_BYTES) return 'O áudio excede o limite de 25 MB.'
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase()
  if (!CODEX_ACTION_ALLOWED_AUDIO_TYPES.has(normalized)) return 'Tipo de áudio não permitido.'
  return null
}
