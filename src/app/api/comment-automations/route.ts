import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { instagramCommentAutomations } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { requireCompany, AuthError } from '@/lib/auth'

function isUnauthorizedError(error: unknown): boolean {
  return error instanceof AuthError || (
    typeof error === 'object' && error !== null && 'status' in error && error.status === 401
  )
}

export async function GET() {
  try {
    const company = await requireCompany()
    const rules = await db
      .select()
      .from(instagramCommentAutomations)
      .where(eq(instagramCommentAutomations.companyId, company.id))
      .orderBy(desc(instagramCommentAutomations.createdAt))

    return NextResponse.json({ automations: rules })
  } catch (err: unknown) {
    if (isUnauthorizedError(err)) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    console.error('[Comment Automations GET Error]:', err)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const company = await requireCompany()
    const parsedBody: unknown = await req.json().catch(() => null)
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return NextResponse.json({ error: 'O corpo da requisição deve ser um objeto JSON.' }, { status: 400 })
    }
    const body = parsedBody as Record<string, unknown>

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
      requireFollowCheck = false,
    } = body

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'O nome da automação é obrigatório.' }, { status: 400 })
    }

    if (!dmMessage || typeof dmMessage !== 'string' || !dmMessage.trim()) {
      return NextResponse.json({ error: 'A mensagem da DM é obrigatória.' }, { status: 400 })
    }

    const optionalTextFields = [
      ['mediaId', mediaId],
      ['mediaUrl', mediaUrl],
      ['mediaCaption', mediaCaption],
      ['keywords', keywords],
      ['publicReply', publicReply],
      ['activeHoursStart', activeHoursStart],
      ['activeHoursEnd', activeHoursEnd],
    ] as const
    const invalidTextField = optionalTextFields.find(([, value]) => value != null && typeof value !== 'string')
    if (invalidTextField) {
      return NextResponse.json(
        { error: `O campo ${invalidTextField[0]} deve ser um texto.` },
        { status: 400 },
      )
    }

    const [created] = await db
      .insert(instagramCommentAutomations)
      .values({
        companyId: company.id,
        name: name.trim(),
        mediaId: typeof mediaId === 'string' ? mediaId.trim() || null : null,
        mediaUrl: typeof mediaUrl === 'string' ? mediaUrl.trim() || null : null,
        mediaCaption: typeof mediaCaption === 'string' ? mediaCaption.trim() || null : null,
        keywords: typeof keywords === 'string' ? keywords.trim() || null : null,
        matchType: typeof matchType === 'string' && ['contains', 'exact', 'any'].includes(matchType) ? matchType : 'contains',
        dmMessage: dmMessage.trim(),
        publicReply: typeof publicReply === 'string' ? publicReply.trim() || null : null,
        hideCommentAfterReply: Boolean(hideCommentAfterReply),
        activeHoursStart: typeof activeHoursStart === 'string' ? activeHoursStart.trim() || null : null,
        activeHoursEnd: typeof activeHoursEnd === 'string' ? activeHoursEnd.trim() || null : null,
        isActive: Boolean(isActive),
        requireFollowCheck: Boolean(requireFollowCheck),
      })
      .returning()

    return NextResponse.json({ automation: created }, { status: 201 })
  } catch (err: unknown) {
    if (isUnauthorizedError(err)) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    console.error('[Comment Automations POST Error]:', err)
    return NextResponse.json({ error: 'Erro interno ao criar automação' }, { status: 500 })
  }
}
