import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export interface InstagramStory {
  id: string
  media_type?: string
  media_url?: string
  thumbnail_url?: string
  timestamp?: string
  permalink?: string
}

/** Lista somente Stories ativos que a API da Meta ainda expõe (em geral, 24 h). */
export async function getInstagramActiveStories(companyId: number): Promise<{ ok: true; stories: InstagramStory[] } | { ok: false; error: string; status: number }> {
  const [config] = await db.select({ token: settings.instagramAccessToken, accountId: settings.instagramAccountId })
    .from(settings).where(eq(settings.companyId, companyId)).limit(1)
  const token = config?.token?.trim()
  const accountId = config?.accountId?.trim()
  if (!token || !accountId) return { ok: false, error: 'O token ou a conta do Instagram não estão configurados para esta empresa.', status: 400 }

  try {
    const url = new URL(`https://graph.instagram.com/v21.0/${encodeURIComponent(accountId)}/stories`)
    url.searchParams.set('fields', 'id,media_type,media_url,thumbnail_url,timestamp,permalink')
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000), cache: 'no-store' })
    const payload = await response.json().catch(() => ({})) as { data?: unknown; error?: { message?: string } }
    if (!response.ok) {
      const code = payload.error && typeof (payload.error as { code?: unknown }).code === 'number' ? (payload.error as { code: number }).code : null
      if (response.status === 401 || code === 190) return { ok: false, error: 'Reconecte o Instagram para listar os Stories.', status: 502 }
      if (response.status === 429) return { ok: false, error: 'A Meta limitou as consultas. Tente novamente em instantes.', status: 502 }
      return { ok: false, error: 'A Meta não conseguiu listar os Stories agora.', status: 502 }
    }
    const stories = Array.isArray(payload.data) ? payload.data.filter((item): item is InstagramStory => !!item && typeof item === 'object' && typeof (item as InstagramStory).id === 'string') : []
    return { ok: true, stories }
  } catch (error) {
    const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
    return { ok: false, error: isTimeout ? 'A Meta demorou para responder. Tente novamente.' : 'Não foi possível buscar os Stories agora.', status: 502 }
  }
}
