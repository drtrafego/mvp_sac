import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { instagramCommentAutomations } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { requireCompany, AuthError } from '@/lib/auth'

export async function GET() {
  try {
    const company = await requireCompany()
    const rules = await db
      .select()
      .from(instagramCommentAutomations)
      .where(eq(instagramCommentAutomations.companyId, company.id))
      .orderBy(desc(instagramCommentAutomations.createdAt))

    return NextResponse.json({ automations: rules })
  } catch (err: any) {
    if (err instanceof AuthError || err?.status === 401) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    console.error('[Comment Automations GET Error]:', err)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const company = await requireCompany()
    const body = await req.json().catch(() => ({}))

    const {
      name,
      mediaId,
      mediaUrl,
      mediaCaption,
      keywords,
      matchType = 'contains',
      dmMessage,
      publicReply,
      hideCommentAfterReply = false,
      activeHoursStart,
      activeHoursEnd,
      isActive = true,
    } = body

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'O nome da automação é obrigatório.' }, { status: 400 })
    }

    if (!dmMessage || typeof dmMessage !== 'string' || !dmMessage.trim()) {
      return NextResponse.json({ error: 'A mensagem da DM é obrigatória.' }, { status: 400 })
    }

    const [created] = await db
      .insert(instagramCommentAutomations)
      .values({
        companyId: company.id,
        name: name.trim(),
        mediaId: mediaId?.trim() || null,
        mediaUrl: mediaUrl?.trim() || null,
        mediaCaption: mediaCaption?.trim() || null,
        keywords: keywords?.trim() || null,
        matchType: ['contains', 'exact', 'any'].includes(matchType) ? matchType : 'contains',
        dmMessage: dmMessage.trim(),
        publicReply: publicReply?.trim() || null,
        hideCommentAfterReply: Boolean(hideCommentAfterReply),
        activeHoursStart: activeHoursStart?.trim() || null,
        activeHoursEnd: activeHoursEnd?.trim() || null,
        isActive: Boolean(isActive),
      })
      .returning()

    return NextResponse.json({ automation: created }, { status: 201 })
  } catch (err: any) {
    if (err instanceof AuthError || err?.status === 401) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    console.error('[Comment Automations POST Error]:', err)
    return NextResponse.json({ error: 'Erro interno ao criar automação' }, { status: 500 })
  }
}
