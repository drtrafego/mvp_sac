import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { companies, settings, whatsappMessages, webhookReceived } from "@/lib/db/schema"
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

  return NextResponse.json({ success: true })
}