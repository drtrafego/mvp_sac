import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { companies, settings, whatsappMessages, recoveryLeads, webhookReceived } from "@/lib/db/schema"
import { eq } from "drizzle-orm"
import { checkWebhookToken } from "@/lib/webhook-auth"
import { maskedHeaders } from "@/lib/webhook-headers"

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
  const auth = checkWebhookToken(req)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status })
  }

  const { slug } = await params
  const [company] = await db.select().from(companies).where(eq(companies.slug, slug))
  if (!company) {
    return NextResponse.json({ error: "Empresa não encontrada" }, { status: 404 })
  }

  const headersObj = maskedHeaders(req)
  let rawBody: Record<string, unknown> = {}
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: "Payload JSON inválido" }, { status: 400 })
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
            await db.insert(whatsappMessages).values({
              companyId: company.id,
              phone: `ig_${sender.id}`,
              direction: "inbound",
              content: message.text,
              messageType: "text",
              sentBy: "human",
              externalId: message.mid ?? null,
            })
          } catch (err) {
            console.error("[Instagram Webhook] Erro ao gravar mensagem:", err)
          }
        }
      }
    }
  }

  return NextResponse.json({ success: true })
}