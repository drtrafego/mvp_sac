export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { instagramCommentAutomations, instagramCommentLogs } from '@/lib/db/schema'
import { authenticateAgentRequest, logAgentActivity } from '@/lib/agent-auth'
import { and, eq, sql } from 'drizzle-orm'
import { normalizeCommentKeywordText } from '@/lib/instagram-comment-keywords'

type Params = { params: Promise<{ idOrSlug: string }> }

const MATCH_TYPES = ['contains', 'exact', 'any'] as const
const MAX_MANUAL_COMMENT_IDS = 100

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
    if (body.all_posts !== undefined && typeof body.all_posts !== 'boolean') {
      return NextResponse.json({ error: 'O campo all_posts deve ser booleano.' }, { status: 400 })
    }
    const allPosts = body.all_posts === true
    const missingFields = [
      ...(allPosts ? [] : [['media_id', body.media_id]]),
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
    if (
      body.manual_comment_ids !== undefined &&
      (!Array.isArray(body.manual_comment_ids) ||
        body.manual_comment_ids.length > MAX_MANUAL_COMMENT_IDS ||
        body.manual_comment_ids.some((value) => !isFilledString(value)))
    ) {
      return NextResponse.json(
        { error: `O campo manual_comment_ids deve ser uma lista de até ${MAX_MANUAL_COMMENT_IDS} IDs de comentário preenchidos.` },
        { status: 400 },
      )
    }

    const companyId = context.company.id
    // Em regra global, media_id é deliberadamente ignorado, inclusive se veio
    // por engano no payload do publicador.
    const mediaId = allPosts ? null : (body.media_id as string).trim()
    const keyword = (body.keyword as string).trim()
    const normalizedKeyword = normalizeCommentKeywordText(keyword)
    // O texto da DM é deliberadamente persistido sem trim/normalização.
    const dmMessage = body.dm_message as string
    const suppliedName = body.name as string | undefined
    const suppliedMediaUrl = body.media_url as string | undefined
    const suppliedMatchType = body.match_type as typeof MATCH_TYPES[number] | undefined
    const manualCommentIds = body.manual_comment_ids === undefined
      ? []
      : [...new Set((body.manual_comment_ids as string[]).map((value) => value.trim()))]

    const updateData: Partial<typeof instagramCommentAutomations.$inferInsert> = {
      keywords: keyword,
      dmMessage,
      updatedAt: new Date(),
    }
    if (suppliedName !== undefined) updateData.name = suppliedName.trim()
    if (suppliedMediaUrl !== undefined) updateData.mediaUrl = suppliedMediaUrl.trim()
    if (suppliedMatchType !== undefined) updateData.matchType = suppliedMatchType

    let result: { automation: typeof instagramCommentAutomations.$inferSelect, created: boolean }
    if (!allPosts) {
      const conflictWhere = sql`media_id is not null and media_id != ''`
      const [insertedAutomation] = await db
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
        .onConflictDoNothing({
          target: [instagramCommentAutomations.companyId, instagramCommentAutomations.mediaId],
          where: conflictWhere,
        })
        .returning()

      result = { automation: insertedAutomation, created: true }
      if (!insertedAutomation) {
        const [updatedAutomation] = await db
          .update(instagramCommentAutomations)
          .set(updateData)
          .where(
            and(
              eq(instagramCommentAutomations.companyId, companyId),
              eq(instagramCommentAutomations.mediaId, mediaId!),
            ),
          )
          .returning()

        if (!updatedAutomation) {
          throw new Error('Não foi possível garantir a automação para a mídia informada.')
        }
        result = { automation: updatedAutomation, created: false }
      }
    } else {
      const globalWhere = and(
        eq(instagramCommentAutomations.companyId, companyId),
        eq(instagramCommentAutomations.triggerType, 'comment'),
        sql`(${instagramCommentAutomations.templateId} is null or ${instagramCommentAutomations.templateId} = '')`,
        sql`(${instagramCommentAutomations.mediaId} is null or ${instagramCommentAutomations.mediaId} = '')`,
      )
      // A normalização é a mesma do matcher de comentários: remove acento,
      // caixa e espaços. Há poucas regras globais por empresa, por isso a
      // comparação é feita aqui em vez de depender de unaccent no banco.
      const globalRules = await db.select().from(instagramCommentAutomations)
        .where(globalWhere)
        .orderBy(instagramCommentAutomations.id)
      const existingAutomation = globalRules.find(rule =>
        normalizeCommentKeywordText(rule.keywords ?? '') === normalizedKeyword,
      )
      const globalUpdate = {
        ...updateData,
        isActive: true,
        mediaId: null,
        mediaUrl: null,
        publicReply: null,
        requireFollowCheck: false,
        hideCommentAfterReply: false,
        activeHoursStart: null,
        activeHoursEnd: null,
      }

      if (existingAutomation) {
        const [automation] = await db.update(instagramCommentAutomations)
          .set(globalUpdate)
          .where(and(eq(instagramCommentAutomations.id, existingAutomation.id), globalWhere))
          .returning()
        if (!automation) throw new Error('Não foi possível atualizar a automação global do Instagram.')
        result = { automation, created: false }
      } else {
        // Este driver Neon não suporta transaction. Sem índice único, uma
        // corrida extrema ainda pode criar duplicata; é inofensiva porque o
        // processador envia somente a primeira regra que casa.
        const insertedResult = await db.execute(sql`
          insert into instagram_comment_automations
            (company_id, name, media_id, media_url, keywords, match_type, dm_message, is_active, trigger_type)
          select ${companyId}, ${suppliedName?.trim() || `Instagram ${keyword}`}, null, null, ${keyword}, ${suppliedMatchType || 'contains'}, ${dmMessage}, true, 'comment'
          where not exists (
            select 1 from instagram_comment_automations
            where company_id = ${companyId}
              and trigger_type = 'comment'
              and (template_id is null or template_id = '')
              and (media_id is null or media_id = '')
              and lower(btrim(keywords)) = ${keyword.toLowerCase()}
          )
          returning id
        `)
        const insertedRows = Array.isArray(insertedResult)
          ? insertedResult as Array<{ id: number }>
          : (insertedResult as unknown as { rows?: Array<{ id: number }> }).rows ?? []
        const insertedId = insertedRows[0]?.id
        if (insertedId) {
          const [automation] = await db.select().from(instagramCommentAutomations)
            .where(eq(instagramCommentAutomations.id, insertedId)).limit(1)
          if (!automation) throw new Error('Não foi possível ler a automação global criada.')
          result = { automation, created: true }
        } else {
          const retryRules = await db.select().from(instagramCommentAutomations).where(globalWhere).orderBy(instagramCommentAutomations.id)
          const retry = retryRules.find(rule => normalizeCommentKeywordText(rule.keywords ?? '') === normalizedKeyword)
          if (!retry) throw new Error('Não foi possível garantir a automação global do Instagram.')
          const [automation] = await db.update(instagramCommentAutomations).set(globalUpdate)
            .where(and(eq(instagramCommentAutomations.id, retry.id), globalWhere)).returning()
          if (!automation) throw new Error('Não foi possível atualizar a automação global do Instagram.')
          result = { automation, created: false }
        }
      }
    }

    // Comentários respondidos manualmente antes da regra entrar no ar não podem
    // receber uma Private Reply retrospectiva caso a Meta reenvie o webhook.
    // O processador consulta esta mesma tabela por company_id + comment_id antes
    // de qualquer chamada à Graph API. A origem manual fica auditável no log e o
    // ON CONFLICT torna uma repetição deste ensure segura.
    if (manualCommentIds.length > 0) {
      await db.insert(instagramCommentLogs).values(
        manualCommentIds.map((commentId) => ({
          companyId,
          automationId: result.automation.id,
          commentId,
          commenterId: `manual:${commentId}`,
          mediaId,
          status: 'skipped',
          errorMessage: 'Comentário já respondido manualmente antes da ativação da automação.',
        })),
      ).onConflictDoNothing()
    }

    await logAgentActivity({
      companyId,
      agentName: context.agentName,
      agentId: context.agentId,
      action: 'ensure_instagram_automation',
      entityType: 'instagram_comment_automation',
      entityId: String(result.automation.id),
      details: allPosts
        ? { mediaId, allPosts, created: result.created, manuallyExcludedCommentCount: manualCommentIds.length }
        : { mediaId, created: result.created, manuallyExcludedCommentCount: manualCommentIds.length },
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
