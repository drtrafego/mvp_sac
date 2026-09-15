import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export interface SendInstagramMessageOptions {
  recipientId: string
  text?: string
  mediaUrl?: string
  mediaType?: 'image' | 'video' | 'audio'
  companyId: number
}

/**
 * Envia mensagens no Instagram Direct utilizando a Meta Graph API oficial.
 */
export async function sendInstagramMessage({
  recipientId,
  text,
  mediaUrl,
  mediaType = 'image',
  companyId,
}: SendInstagramMessageOptions): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const [config] = await db.select().from(settings).where(eq(settings.companyId, companyId))

  const token = config?.instagramAccessToken || config?.metaAccessToken || process.env.META_ACCESS_TOKEN
  if (!token) {
    return { ok: false, error: 'Token de acesso do Instagram não configurado nas Configurações da empresa.' }
  }

  // Remove o prefixo "ig_" caso o identificador tenha sido salvo dessa forma
  const cleanRecipientId = recipientId.replace(/^ig_/, '')

  const payload: Record<string, unknown> = {
    recipient: { id: cleanRecipientId },
  }

  if (mediaUrl) {
    payload.message = {
      attachment: {
        type: mediaType,
        payload: { url: mediaUrl, is_reusable: true },
      },
    }
  } else if (text) {
    payload.message = { text }
  } else {
    return { ok: false, error: 'Mensagem sem conteúdo.' }
  }

  try {
    const pageId = config?.instagramPageId || 'me'
    const res = await fetch(`https://graph.facebook.com/v21.0/${pageId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

    if (!res.ok) {
      const errDetail = (data.error as Record<string, unknown>)?.message || JSON.stringify(data)
      console.error('[Instagram Send Error]:', errDetail)
      return { ok: false, error: `Erro no envio do Instagram Direct: ${errDetail}` }
    }

    const messageId = (data.message_id as string) || (data.id as string)
    return { ok: true, messageId }
  } catch (error) {
    console.error('[Instagram Send Exception]:', error)
    return { ok: false, error: String(error) }
  }
}
