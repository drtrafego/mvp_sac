import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { companies, settings, whatsappMessages, webhookReceived, recoveryLeads } from "@/lib/db/schema"
import { eq } from "drizzle-orm"

/**
 * GET - Global Meta Instagram Webhook verification handshake
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get("hub.mode")
  const token = searchParams.get("hub.verify_token")
  const challenge = searchParams.get("hub.challenge")

  if (mode === "subscribe" && token && (token === process.env.META_VERIFY_TOKEN || token === process.env.INSTAGRAM_VERIFY_TOKEN)) {
    return new NextResponse(challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }

  // Verifica se o token pertence a alguma empresa
  if (token) {
    const [found] = await db.select().from(settings).where(eq(settings.instagramVerifyToken, token))
    if (found && mode === "subscribe") {
      return new NextResponse(challenge ?? "", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    }
  }

  return new NextResponse("Token de verificação inválido", { status: 403 })
}

/**
 * POST - Global Instagram message receiver
 */
export async function POST(req: NextRequest) {
  let rawBody: Record<string, unknown> = {}
  try {
    rawBody = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  try {
    if (rawBody.object === 'instagram' && Array.isArray(rawBody.entry)) {
      for (const entry of rawBody.entry as Record<string, unknown>[]) {
        const pageId = (entry.id as string) || ''
        const messagingList = (entry.messaging as Record<string, unknown>[]) ?? []

        // Encontra a empresa correspondente pelo instagramAccountId ou instagramPageId
        let [matchedSetting] = await db
          .select()
          .from(settings)
          .where(eq(settings.instagramAccountId, pageId))
          .limit(1)

        if (!matchedSetting) {
          const [byPageId] = await db
            .select()
            .from(settings)
            .where(eq(settings.instagramPageId, pageId))
            .limit(1)
          matchedSetting = byPageId
        }

        const companyId = matchedSetting?.companyId ?? null

        if (companyId) {
          for (const item of messagingList) {
            const sender = item.sender as { id?: string } | undefined
            const message = item.message as { mid?: string; text?: string } | undefined
            if (sender?.id && message?.text) {
              const igPhone = `ig_${sender.id}`

              let [lead] = await db
                .select()
                .from(recoveryLeads)
                .where(eq(recoveryLeads.phone, igPhone))
                .limit(1)

              if (!lead) {
                const [newLead] = await db
                  .insert(recoveryLeads)
                  .values({
                    companyId,
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
                companyId,
                leadId: lead?.id ?? null,
                phone: igPhone,
                channel: 'instagram',
                direction: 'inbound',
                content: message.text,
                messageType: 'text',
                sentBy: 'user',
                externalId: message.mid ?? null,
              })
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[Global Instagram Webhook Error]:', err)
  }

  return NextResponse.json({ success: true })
}