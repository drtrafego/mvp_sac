import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { companies, settings, whatsappMessages, recoveryLeads, webhookReceived } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { maskedHeaders } from "@/lib/webhook-headers"
import { verifyMetaSignature } from "@/lib/meta-signature"
import { processInstagramComment } from "@/lib/instagram-comment-processor"
import { markLeadContacted } from "@/lib/leads"

interface RouteContext {
  params: Promise<{ slug: string }>
}

/**
 * GET - Handshake de verificação do Webhook da Meta (Instagram Messaging)
 */
export async function GET(req: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get("hub.mode")
  const token = searchParams.get("hub.verify_token")
  const challenge = searchParams.get("hub.challenge")

  if (!mode || !token) {
    return new NextResponse("Parâmetros inválidos", { status: 400 })
  }

  const [company] = await db.select().from(companies).where(eq(companies.slug, slug))
  if (!company) {
    return new NextResponse("Empresa não encontrada", { status: 404 })
  }

  const [companySettings] = await db.select().from(settings).where(eq(settings.companyId, company.id))
  const expectedToken = companySettings?.instagramVerifyToken || companySettings?.metaVerifyToken || process.env.META_VERIFY_TOKEN

  if (mode === "subscribe" && token === expectedToken) {
    return new NextResponse(challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }

  return new NextResponse("Token de verificação inválido", { status: 403 })
}

/**
 * POST - Recebimento de eventos e mensagens diretas do Instagram via Meta Graph API
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const [company] = await db.select().from(companies).where(eq(companies.slug, slug))
  if (!company) {
    return NextResponse.json({ error: "Empresa não encontrada" }, { status: 404 })
  }

  const headersObj = maskedHeaders(req)
  let rawBodyText = ""
  let rawBody: Record<string, unknown> = {}
  try {
    rawBodyText = await req.text()
    rawBody = JSON.parse(rawBodyText) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Payload JSON inválido" }, { status: 400 })
  }

  // Validação da assinatura x-hub-signature-256 da Meta: falha fechada, nunca aceita sem checagem.
  // Empresa já foi resolvida pelo slug acima: se ela tiver App Secret próprio, usa o dela;
  // senão cai no META_APP_SECRET compartilhado de hoje.
  const [companySettingsForSecret] = await db.select().from(settings).where(eq(settings.companyId, company.id))
  const secret = companySettingsForSecret?.metaAppSecret || process.env.META_APP_SECRET || process.env.INSTAGRAM_APP_SECRET
  if (!secret) {
    console.error("[Instagram Webhook] Nenhum App Secret configurado (nem da empresa, nem o compartilhado), recusando requisição")
    return NextResponse.json({ error: "meta_app_secret_not_configured" }, { status: 503 })
  }
  const sigHeader = req.headers.get("x-hub-signature-256")
  if (!sigHeader || !verifyMetaSignature(rawBodyText, sigHeader, secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 })
  }

  try {
    await db.insert(webhookReceived).values({
      companyId: company.id,
      slug,
      source: "instagram",
      event: (rawBody.object as string) || "instagram_direct",
      processed: true,
      rawBody,
      headers: headersObj,
    })
  } catch (err) {
    console.error("[Instagram Webhook] Erro ao registrar webhook_received:", err)
  }

  if (rawBody.object === "instagram" && Array.isArray(rawBody.entry)) {
    for (const entry of rawBody.entry as Record<string, unknown>[]) {
      const messagingList = (entry.messaging as Record<string, unknown>[]) ?? []
      for (const item of messagingList) {
        const sender = item.sender as { id?: string } | undefined
        const message = item.message as { mid?: string; text?: string } | undefined
        if (sender?.id && message?.text) {
          try {
            const igPhone = `ig_${sender.id}`

            // Busca ou cria o lead para a conversa aparecer no Inbox
            let [lead] = await db
              .select()
              .from(recoveryLeads)
              .where(eq(recoveryLeads.phone, igPhone))
              .limit(1)

            if (!lead) {
              const [newLead] = await db
                .insert(recoveryLeads)
                .values({
                  companyId: company.id,
                  platform: 'instagram',
                  channel: 'instagram',
                  eventType: 'instagram_direct',
                  phone: igPhone,
                  name: `Instagram Direct (${sender.id.slice(-4)})`,
                  status: 'in_conversation',
                  trackingSource: 'instagram_direct',
                })
                .returning()
              lead = newLead
            } else {
              await db
                .update(recoveryLeads)
                .set({ updatedAt: new Date(), channel: 'instagram' })
                .where(eq(recoveryLeads.id, lead.id))
            }

            await db.insert(whatsappMessages).values({
              companyId: company.id,
              leadId: lead?.id ?? null,
              phone: igPhone,
              channel: 'instagram',
              direction: 'inbound',
              content: message.text,
              messageType: 'text',
              sentBy: 'user',
              externalId: message.mid ?? null,
            })

            // Mensagem real trocada: se for a primeira, marca a abordagem do lead
            await markLeadContacted(lead?.id)
          } catch (err) {
            console.error("[Instagram Webhook] Erro ao gravar mensagem:", err)
          }
        }
      }

      // 2. Comentários em Posts/Reels (Comentário vira DM)
      const changesList = (entry.changes as Record<string, unknown>[]) ?? []
      for (const change of changesList) {
        if (change.field === 'comments' && change.value) {
          const val = change.value as Record<string, unknown>
          const commentId = (val.id as string) || ''
          const commentText = (val.text as string) || ''
          const fromObj = val.from as { id?: string; username?: string } | undefined
          const commenterId = fromObj?.id || ''
          const commenterUsername = fromObj?.username
          const mediaObj = val.media as { id?: string } | undefined
          const mediaId = mediaObj?.id || (val.media_id as string) || ''

          if (commentId && commenterId && commentText) {
            await processInstagramComment({
              companyId: company.id,
              commentId,
              commenterId,
              commenterUsername,
              mediaId,
              commentText,
            }).catch(err => console.error(`[Comment-to-DM Webhook ${slug} Error]:`, err))
          }
        }
      }
    }
  }

  return NextResponse.json({ success: true })
}