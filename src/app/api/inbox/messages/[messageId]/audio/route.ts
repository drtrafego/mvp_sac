import { and, eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { settings, whatsappMessages } from '@/lib/db/schema'
import { extractAudioMediaId } from '@/lib/whatsapp/audio-media'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const META_API_VERSION = 'v19.0'
const MAX_AUDIO_BYTES = 16 * 1024 * 1024
const META_TIMEOUT_MS = 15_000
const AUDIO_UNAVAILABLE = 'Áudio indisponível (a Meta guarda a mídia por 30 dias).'

type Params = { params: Promise<{ messageId: string }> }

function metaUnavailable() {
  return NextResponse.json({ error: AUDIO_UNAVAILABLE }, { status: 404 })
}

function metaFailure() {
  return NextResponse.json({ error: 'Não foi possível obter o áudio da Meta.' }, { status: 502 })
}

function isAllowedMetaMediaUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') || url.username || url.password) return false
    const host = url.hostname.toLowerCase()
    return host === 'facebook.com' || host.endsWith('.facebook.com')
      || host === 'fbcdn.net' || host.endsWith('.fbcdn.net')
      || host === 'whatsapp.net' || host.endsWith('.whatsapp.net')
      // This is the documented host returned by the WhatsApp Cloud API media
      // endpoint; accepting only this exact fbsbx host avoids broadening the
      // allowlist to arbitrary Meta-adjacent domains.
      || host === 'lookaside.fbsbx.com'
  } catch {
    return false
  }
}

function contentTypeFromMeta(value: unknown): string {
  if (typeof value !== 'string') return 'audio/ogg'
  const mimeType = value.trim()
  // Meta sends audio MIME values such as "audio/ogg; codecs=opus". Keep only
  // syntactically safe values because this becomes a response header.
  return /^audio\/[a-z0-9.+-]+(?:\s*;\s*[a-z0-9.+-]+(?:=(?:"[^"]*"|[a-z0-9.+-]+))?)*$/i.test(mimeType)
    ? mimeType
    : 'audio/ogg'
}

function isOverSizeLimit(response: Response): boolean {
  const contentLength = response.headers.get('content-length')
  if (contentLength) {
    const size = Number(contentLength)
    if (Number.isFinite(size) && size > MAX_AUDIO_BYTES) return true
  }
  const totalFromRange = response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]
  return totalFromRange !== undefined && Number(totalFromRange) > MAX_AUDIO_BYTES
}

function limitAudioStream(body: ReadableStream<Uint8Array>, onFinished: () => void): ReadableStream<Uint8Array> {
  let totalBytes = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength
      if (totalBytes > MAX_AUDIO_BYTES) {
        onFinished()
        controller.error(new Error('Meta audio exceeded size limit'))
        return
      }
      controller.enqueue(chunk)
    },
    flush() {
      onFinished()
    },
  }))
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { messageId: rawMessageId } = await params
  const messageId = Number(rawMessageId)
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    return NextResponse.json({ error: 'Mensagem inválida.' }, { status: 400 })
  }

  const company = await requireCompany()
  const [message] = await db
    .select({ mediaUrl: whatsappMessages.mediaUrl })
    .from(whatsappMessages)
    .where(and(
      eq(whatsappMessages.id, messageId),
      eq(whatsappMessages.companyId, company.id),
      eq(whatsappMessages.direction, 'inbound'),
      eq(whatsappMessages.messageType, 'audio'),
    ))
    .limit(1)

  if (!message) return metaUnavailable()

  const mediaId = extractAudioMediaId(message.mediaUrl)
  if (!mediaId) return metaUnavailable()

  // Same company settings used by sendWhatsAppMessage() for the Meta provider.
  const [config] = await db
    .select({ metaAccessToken: settings.metaAccessToken })
    .from(settings)
    .where(eq(settings.companyId, company.id))
    .limit(1)
  const accessToken = config?.metaAccessToken?.trim()
  if (!accessToken) {
    return NextResponse.json({ error: 'Meta Cloud API não configurada.' }, { status: 409 })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), META_TIMEOUT_MS)
  const authorization = `Bearer ${accessToken}`
  let streamOwnsTimeout = false

  try {
    let metadataResponse: Response
    try {
      metadataResponse = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${mediaId}`, {
        headers: { Authorization: authorization },
        signal: controller.signal,
        redirect: 'manual',
      })
    } catch {
      return metaFailure()
    }

    if (metadataResponse.status === 400 || metadataResponse.status === 404) {
      await metadataResponse.body?.cancel().catch(() => undefined)
      return metaUnavailable()
    }
    // Redirects are never followed: the Bearer token must only reach the allowlisted hosts.
    if (!metadataResponse.ok) {
      controller.abort()
      await metadataResponse.body?.cancel().catch(() => undefined)
      return metaFailure()
    }

    let metadata: { url?: unknown; mime_type?: unknown }
    try {
      metadata = await metadataResponse.json() as { url?: unknown; mime_type?: unknown }
    } catch {
      return metaFailure()
    }
    if (!isAllowedMetaMediaUrl(metadata.url)) return metaFailure()

    const downloadHeaders = new Headers({ Authorization: authorization })
    const range = request.headers.get('range')
    if (range) downloadHeaders.set('Range', range)

    let downloadResponse: Response
    try {
      downloadResponse = await fetch(metadata.url, {
        headers: downloadHeaders,
        signal: controller.signal,
        redirect: 'manual',
      })
    } catch {
      return metaFailure()
    }

    if (downloadResponse.status === 400 || downloadResponse.status === 404) {
      await downloadResponse.body?.cancel().catch(() => undefined)
      return metaUnavailable()
    }
    if (!downloadResponse.ok || !downloadResponse.body || isOverSizeLimit(downloadResponse)) {
      controller.abort()
      await downloadResponse.body?.cancel().catch(() => undefined)
      return metaFailure()
    }

    const headers = new Headers({
      'Content-Type': contentTypeFromMeta(metadata.mime_type),
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    })
    const contentLength = downloadResponse.headers.get('content-length')
    const contentRange = downloadResponse.headers.get('content-range')
    const acceptRanges = downloadResponse.headers.get('accept-ranges')
    if (contentLength) headers.set('Content-Length', contentLength)
    if (contentRange) headers.set('Content-Range', contentRange)
    if (acceptRanges) headers.set('Accept-Ranges', acceptRanges)

    const audioStream = limitAudioStream(downloadResponse.body, () => clearTimeout(timeout))
    streamOwnsTimeout = true
    return new Response(audioStream, {
      status: downloadResponse.status,
      headers,
    })
  } finally {
    // A successful response still has an open upstream body. Its stream clears
    // this timer on completion; otherwise the abort keeps the 15s ceiling.
    if (!streamOwnsTimeout) clearTimeout(timeout)
  }
}
