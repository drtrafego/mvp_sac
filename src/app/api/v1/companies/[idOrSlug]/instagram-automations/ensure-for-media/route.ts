export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { instagramCommentAutomations } from '@/lib/db/schema'
import { authenticateAgentRequest, logAgentActivity } from '@/lib/agent-auth'
import { and, eq, sql } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string }> }

const MATCH_TYPES = ['contains', 'exact', 'any'] as const

function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  try {
    const parsedBody: unknown = await req.json().catch(() => null)
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return NextResponse.json(
        { error: 'O corpo da requisição deve ser um objeto JSON.' },
        { status: 400 },
      )
    }

    const body = parsedBody as Record<string, unknown>
    const missingFields = [
      ['media_id', body.media_id],
      ['keyword', body.keyword],
      ['dm_message', body.dm_message],
    ]
      .filter(([, value]) => !isFilledString(value))
      .map(([field]) => field)

    if (missingFields.length > 0) {
      return NextResponse.json(
        { error: `Campos obrigatórios ausentes ou vazios: ${missingFields.join(', ')}.` },
        { status: 400 },
      )
    }

    if (typeof body.dm_message === 'string' && body.dm_message.length > 4000) {
      return NextResponse.json(
        { error: 'dm_message excede o limite de 4000 caracteres' },
        { status: 400 },
      )
    }

    if (body.name !== undefined && !isFilledString(body.name)) {
      return NextResponse.json({ error: 'O campo name deve ser um texto preenchido.' }, { status: 400 })
    }
    if (body.media_url !== undefined && typeof body.media_url !== 'string') {
      return NextResponse.json({ error: 'O campo media_url deve ser um texto.' }, { status: 400 })
    }
    if (
      body.match_type !== undefined &&
      (typeof body.match_type !== 'string' || !MATCH_TYPES.includes(body.match_type as typeof MATCH_TYPES[number]))
    ) {
      return NextResponse.json(
        { error: `O campo match_type deve ser um destes valores: ${MATCH_TYPES.join(', ')}.` },
        { status: 400 },
      )
    }

    const companyId = context.company.id
    const mediaId = (body.media_id as string).trim()
    const keyword = (body.keyword as string).trim()
    // O texto da DM é deliberadamente persistido sem trim/normalização.
    const dmMessage = body.dm_message as string
    const suppliedName = body.name as string | undefined
    const suppliedMediaUrl = body.media_url as string | undefined
    const suppliedMatchType = body.match_type as typeof MATCH_TYPES[number] | undefined

    const [existing] = await db
      .select({ id: instagramCommentAutomations.id })
      .from(instagramCommentAutomations)
      .where(
        and(
          eq(instagramCommentAutomations.companyId, companyId),
          eq(instagramCommentAutomations.mediaId, mediaId),
        ),
      )
      .limit(1)

    const updateData: Partial<typeof instagramCommentAutomations.$inferInsert> = {
      keywords: keyword,
      dmMessage,
      isActive: true,
      updatedAt: new Date(),
    }
    if (suppliedName !== undefined) updateData.name = suppliedName.trim()
    if (suppliedMediaUrl !== undefined) updateData.mediaUrl = suppliedMediaUrl.trim()
    if (suppliedMatchType !== undefined) updateData.matchType = suppliedMatchType

    const [upsertedAutomation] = await db
      .insert(instagramCommentAutomations)
      .values({
        companyId,
        name: suppliedName?.trim() || `Instagram ${keyword}`,
        mediaId,
        mediaUrl: suppliedMediaUrl?.trim() || null,
        keywords: keyword,
        matchType: suppliedMatchType || 'contains',
        dmMessage,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: [instagramCommentAutomations.companyId, instagramCommentAutomations.mediaId],
        targetWhere: sql`${instagramCommentAutomations.mediaId} is not null and ${instagramCommentAutomations.mediaId} != ''`,
        set: updateData,
      })
      .returning()

    const result = { automation: upsertedAutomation, created: !existing }

    await logAgentActivity({
      companyId,
      agentName: context.agentName,
      agentId: context.agentId,
      action: 'ensure_instagram_automation',
      entityType: 'instagram_comment_automation',
      entityId: String(result.automation.id),
      details: { mediaId, created: result.created },
    })

    const { automation } = result
    return NextResponse.json({
      ok: true,
      automation: {
        id: automation.id,
        name: automation.name,
        mediaId: automation.mediaId,
        keywords: automation.keywords,
        isActive: automation.isActive,
        companyId: automation.companyId,
      },
      created: result.created,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Erro ao garantir automação do Instagram'
    console.error('[Ensure Instagram Automation Error]', err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
