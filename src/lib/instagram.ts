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
}: SendInstagramMessageOptions): Promise<{ ok: boolean; messageId?: string; error?: string; uncertain?: boolean; isTimeout?: boolean }> {
  const [config] = await db.select().from(settings).where(eq(settings.companyId, companyId))

  const token = config?.instagramAccessToken
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
    const accountId = config?.instagramAccountId || 'me'
    const res = await fetch(`https://graph.instagram.com/v21.0/${accountId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
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
    const value = error as { name?: string }
    return { ok: false, error: error instanceof Error ? error.message : String(error), uncertain: true, isTimeout: value?.name === 'TimeoutError' || value?.name === 'AbortError' }
  }
}

/**
 * Dispara uma resposta privada (Private Reply / DM) diretamente vinculada a um comentário de post/reel.
 * Endpoint Graph API: POST /{page_id}/messages
 * Payload: { recipient: { comment_id: "..." }, message: { text: "..." } }
 */
export async function sendInstagramPrivateReply({
  commentId,
  text,
  companyId,
}: {
  commentId: string
  text: string
  companyId: number
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const [config] = await db.select().from(settings).where(eq(settings.companyId, companyId))
  const token = config?.instagramAccessToken
  if (!token) {
    return { ok: false, error: 'Token de acesso do Instagram não configurado.' }
  }

  const accountId = config?.instagramAccountId || 'me'

  try {
    const res = await fetch(`https://graph.instagram.com/v21.0/${accountId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { comment_id: commentId },
        message: { text },
      }),
    })

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const errDetail = (data.error as Record<string, unknown>)?.message || JSON.stringify(data)
      console.error('[Instagram Private Reply Error]:', errDetail)
      return { ok: false, error: `Erro ao enviar resposta privada: ${errDetail}` }
    }

    const messageId = (data.message_id as string) || (data.id as string)
    return { ok: true, messageId }
  } catch (error) {
    console.error('[Instagram Private Reply Exception]:', error)
    return { ok: false, error: String(error) }
  }
}

/**
 * Consulta se um usuário do Instagram (IGSID) segue a conta da empresa,
 * via Instagram User Profile API (campo is_user_follow_business).
 * Restrição real da Meta (confirmada na doc oficial em 24/09/2026): só dá
 * pra consultar o perfil de alguém DEPOIS que essa pessoa mandou mensagem
 * pra empresa (ou clicou em ice breaker/menu persistente) — comentar num
 * post sozinho não libera esse acesso. Por isso o gate de seguidor
 * (src/lib/instagram-comment-processor.ts) manda uma pergunta intermediária
 * pelo Direct e só chama esta função depois que a pessoa responde.
 */
export async function checkInstagramUserFollowsBusiness({
  igsid,
  companyId,
}: {
  igsid: string
  companyId: number
}): Promise<{ ok: boolean; follows?: boolean; error?: string }> {
  const [config] = await db.select().from(settings).where(eq(settings.companyId, companyId))
  const token = config?.instagramAccessToken
  if (!token) {
    return { ok: false, error: 'Token de acesso do Instagram não configurado.' }
  }

  const cleanId = igsid.replace(/^ig_/, '')

  try {
    // Achado 28/09/2026: token de "instagramAccessToken" é do tipo IGAA
    // (Instagram API with Instagram Login), que graph.facebook.com não
    // consegue nem parsear ("Invalid OAuth access token - Cannot parse
    // access token"). O resto deste arquivo já usa graph.instagram.com
    // pra esse mesmo token (envio de DM, comentário, mídia); esta função
    // era a exceção que ainda chamava o host errado, ficando sempre no
    // fallback silencioso.
    const url = `https://graph.instagram.com/v21.0/${cleanId}?fields=name,is_user_follow_business&access_token=${encodeURIComponent(token)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

    if (!res.ok) {
      const errDetail = (data.error as Record<string, unknown>)?.message || JSON.stringify(data)
      console.error('[Instagram Follow Check Error]:', errDetail)
      return { ok: false, error: `Erro ao consultar perfil do Instagram: ${errDetail}` }
    }

    return { ok: true, follows: data.is_user_follow_business === true }
  } catch (error) {
    console.error('[Instagram Follow Check Exception]:', error)
    return { ok: false, error: String(error) }
  }
}

export async function fetchInstagramUserProfile({
  igsid,
  companyId,
}: {
  igsid: string
  companyId: number
}): Promise<{ ok: boolean; name?: string; username?: string; error?: string }> {
  const [config] = await db.select().from(settings).where(eq(settings.companyId, companyId))
  const token = config?.instagramAccessToken
  if (!token) {
    return { ok: false, error: 'Token de acesso do Instagram não configurado.' }
  }

  const cleanId = igsid.replace(/^ig_/, '')

  try {
    // Timeout curto (5s, não os 10s do resto do arquivo): esta chamada roda
    // SÍNCRONA no path do webhook de DM (route.ts / [slug]/route.ts), antes
    // do 200 sair. A Meta reenvia o evento se a resposta demorar demais, e o
    // nome é enriquecimento best-effort, não vale segurar o webhook por isso.
    // Mesmo achado de 28/09/2026 da função irmã acima: host tem que ser
    // graph.instagram.com pro token IGAA (Instagram Login), não
    // graph.facebook.com — era por isso que o nome nunca resolvia.
    const url = `https://graph.instagram.com/v21.0/${cleanId}?fields=name,username&access_token=${encodeURIComponent(token)}`
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>

    if (!res.ok) {
      const errDetail = (data.error as Record<string, unknown>)?.message || JSON.stringify(data)
      console.error('[Instagram Profile Fetch Error]:', errDetail)
      return { ok: false, error: `Erro ao consultar perfil do Instagram: ${errDetail}` }
    }

    const name = typeof data.name === 'string' && data.name.trim() ? data.name : undefined
    const username = typeof data.username === 'string' && data.username.trim() ? data.username : undefined
    return { ok: true, name, username }
  } catch (error) {
    console.error('[Instagram Profile Fetch Exception]:', error)
    return { ok: false, error: String(error) }
  }
}

/**
 * Publica uma resposta pública diretamente abaixo do comentário original.
 * Endpoint Graph API: POST /{comment_id}/replies
 * Payload: { message: "..." }
 */
export async function replyInstagramCommentPublic({
  commentId,
  text,
  companyId,
}: {
  commentId: string
  text: string
  companyId: number
}): Promise<{ ok: boolean; replyId?: string; error?: string }> {
  const [config] = await db.select().from(settings).where(eq(settings.companyId, companyId))
  const token = config?.instagramAccessToken
  if (!token) {
    return { ok: false, error: 'Token de acesso do Instagram não configurado.' }
  }

  try {
    const res = await fetch(`https://graph.instagram.com/v21.0/${commentId}/replies`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: text }),
    })

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const errDetail = (data.error as Record<string, unknown>)?.message || JSON.stringify(data)
      console.error('[Instagram Public Reply Error]:', errDetail)
      return { ok: false, error: `Erro na resposta pública: ${errDetail}` }
    }

    const replyId = (data.id as string) || undefined
    return { ok: true, replyId }
  } catch (error) {
    console.error('[Instagram Public Reply Exception]:', error)
    return { ok: false, error: String(error) }
  }
}

/**
 * Publica um comentário em um post/reel da conta autorizada pela empresa.
 * Esta função só é chamada pelo endpoint executor do Codex, depois de a
 * intenção ter sido confirmada. O media_id é obrigatório, pois a API não deve
 * escolher um post implícito nem publicar em outra conta.
 */
export async function createInstagramMediaComment({
  mediaId,
  text,
  companyId,
}: {
  mediaId: string
  text: string
  companyId: number
}): Promise<{ ok: boolean; commentId?: string; permalink?: string; error?: string; uncertain?: boolean }> {
  const [config] = await db.select().from(settings).where(eq(settings.companyId, companyId))
  const token = config?.instagramAccessToken?.trim()
  const configuredAccountId = config?.instagramAccountId?.trim()
  if (!token || !configuredAccountId) {
    return { ok: false, error: 'Instagram não está conectado neste tenant: conta ou token ausente.' }
  }
  if (!/^\d+$/.test(mediaId.trim())) {
    return { ok: false, error: 'O media_id do Instagram é inválido.' }
  }
  const commentText = text.trim()
  if (!commentText || commentText.length > 2_200) {
    return { ok: false, error: 'O comentário precisa ter entre 1 e 2.200 caracteres.' }
  }

  try {
    // Leitura anterior é o gate de permissão/asset: o token da empresa precisa
    // conseguir ler o alvo. Não aceitamos URL ou ID fornecido por outro tenant
    // como prova de autorização.
    const mediaResponse = await fetch(`https://graph.instagram.com/v21.0/${mediaId}?fields=id,permalink,username,media_type`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    })
    const media = await mediaResponse.json().catch(() => ({})) as Record<string, unknown>
    if (!mediaResponse.ok) {
      const detail = (media.error as Record<string, unknown>)?.message || JSON.stringify(media)
      return { ok: false, error: `O post do Instagram não pertence à conta autorizada ou não pode ser lido: ${detail}` }
    }
    const mediaOwner = typeof media.username === 'string' ? media.username.trim().toLowerCase() : ''
    const configuredUsername = config.instagramUsername?.trim().replace(/^@/, '').toLowerCase() || ''
    if (mediaOwner && configuredUsername && mediaOwner !== configuredUsername) {
      return { ok: false, error: 'O post pertence a outra conta do Instagram; publicação bloqueada.' }
    }

    const response = await fetch(`https://graph.instagram.com/v21.0/${mediaId}/comments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: commentText }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const detail = (data.error as Record<string, unknown>)?.message || JSON.stringify(data)
      return { ok: false, error: `A API oficial do Instagram recusou o comentário: ${detail}` }
    }
    return {
      ok: true,
      commentId: typeof data.id === 'string' ? data.id : undefined,
      permalink: typeof media.permalink === 'string' ? media.permalink : undefined,
    }
  } catch (error) {
    const uncertain = error instanceof Error && /timeout|abort/i.test(error.name + error.message)
    return { ok: false, uncertain, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Oculta (ou desoculta) um comentário no Instagram.
 * Endpoint Graph API: POST /{comment_id}
 * Payload: { hide: true }
 */
export async function hideInstagramComment({
  commentId,
  companyId,
  hide = true,
}: {
  commentId: string
  companyId: number
  hide?: boolean
}): Promise<{ ok: boolean; error?: string }> {
  const [config] = await db.select().from(settings).where(eq(settings.companyId, companyId))
  const token = config?.instagramAccessToken
  if (!token) {
    return { ok: false, error: 'Token de acesso do Instagram não configurado.' }
  }

  try {
    const res = await fetch(`https://graph.instagram.com/v21.0/${commentId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hide }),
    })

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const errDetail = (data.error as Record<string, unknown>)?.message || JSON.stringify(data)
      console.error('[Instagram Hide Comment Error]:', errDetail)
      return { ok: false, error: `Erro ao ocultar comentário: ${errDetail}` }
    }

    return { ok: true }
  } catch (error) {
    console.error('[Instagram Hide Comment Exception]:', error)
    return { ok: false, error: String(error) }
  }
}

export interface InstagramMediaItem {
  id: string
  caption?: string
  media_type?: string
  media_url?: string
  thumbnail_url?: string
  permalink?: string
  timestamp?: string
}

/**
 * Obtém os posts/reels recentes da conta de Instagram vinculada à empresa.
 */
export async function getInstagramRecentMedia(
  companyId: number,
  limit = 25
): Promise<{ ok: boolean; media: InstagramMediaItem[]; error?: string }> {
  const [config] = await db.select().from(settings).where(eq(settings.companyId, companyId))
  const token = config?.instagramAccessToken
  if (!token) {
    return { ok: false, media: [], error: 'Token de acesso do Instagram não configurado.' }
  }

  const accountId = config?.instagramAccountId || 'me'

  try {
    const url = `https://graph.instagram.com/v21.0/${accountId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=${limit}`
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok) {
      const errDetail = (data.error as Record<string, unknown>)?.message || JSON.stringify(data)
      console.error('[Instagram Get Media Error]:', errDetail)
      return { ok: false, media: [], error: `Erro ao buscar posts: ${errDetail}` }
    }

    const items = (Array.isArray(data.data) ? data.data : []) as InstagramMediaItem[]
    return { ok: true, media: items }
  } catch (error) {
    console.error('[Instagram Get Media Exception]:', error)
    return { ok: false, media: [], error: String(error) }
  }
}
