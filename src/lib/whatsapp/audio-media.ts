const META_MEDIA_ID = /^\d{5,60}$/

/**
 * Returns the Meta Cloud API audio id only when it is safe to persist and
 * later pass to the bridge. Webhook payloads are an external boundary.
 */
export function extractAudioMedia(audio: unknown): string | null {
  if (!audio || typeof audio !== 'object' || Array.isArray(audio)) return null
  const id = (audio as Record<string, unknown>).id
  return typeof id === 'string' && META_MEDIA_ID.test(id) ? id : null
}

/** Reads a validated audio id from SAC's internal media URL marker. */
export function extractAudioMediaId(mediaUrl: string | null | undefined): string | null {
  if (typeof mediaUrl !== 'string' || !mediaUrl.startsWith('wa-media:')) return null
  const id = mediaUrl.slice('wa-media:'.length)
  return META_MEDIA_ID.test(id) ? id : null
}

/**
 * Returns the authenticated SAC audio endpoint for an internally stored Meta
 * media marker. The marker itself must never be exposed as an audio source.
 */
export function audioPlayerUrl(messageId: number | null | undefined, mediaUrl: string | null | undefined): string | null {
  if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId <= 0 || !extractAudioMediaId(mediaUrl)) return null
  return `/api/inbox/messages/${messageId}/audio`
}
