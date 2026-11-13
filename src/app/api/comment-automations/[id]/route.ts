import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { instagramCommentAutomations } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompanyRole, AuthError, ForbiddenError, forbiddenResponse } from '@/lib/auth'
import { findInvalidOptionalTextField } from '@/lib/request-validation'
import { MAX_TAG_LENGTH, normalizeTag } from '@/lib/lead-tags'
import {
  INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
  buildInstagramCommentDmTemplateRegistration,
} from '@/lib/instagram-comment-dm-template'

interface RouteContext {
  params: Promise<{ id: string }>
}
function isForbiddenError(error: unknown): boolean {
  return (typeof ForbiddenError === 'function' && error instanceof ForbiddenError) ||
    (typeof error === 'object' && error !== null && 'status' in error && error.status === 403)
}
function isUnauthorizedError(error: unknown): boolean {
  return (typeof AuthError === 'function' && error instanceof AuthError) ||
    (typeof error === 'object' && error !== null && 'status' in error && error.status === 401)
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { company } = await requireCompanyRole('admin')
    const { id } = await params
    const automationId = parseInt(id, 10)

    if (isNaN(automationId)) {
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    const [rule] = await db
      .select()
      .from(instagramCommentAutomations)
      .where(
        and(
          eq(instagramCommentAutomations.id, automationId),
          eq(instagramCommentAutomations.companyId, company.id)
        )
      )
      .limit(1)

    if (!rule) {
      return NextResponse.json({ error: 'Automação não encontrada' }, { status: 404 })
    }

    return NextResponse.json({ automation: rule })
  } catch (err: unknown) {
    if (isUnauthorizedError(err)) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    if (isForbiddenError(err)) return forbiddenResponse()
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const { company } = await requireCompanyRole('admin')
    const { id } = await params
    const automationId = parseInt(id, 10)

    if (isNaN(automationId)) {
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    const parsedBody: unknown = await req.json().catch(() => null)
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return NextResponse.json({ error: 'O corpo da requisição deve ser um objeto JSON.' }, { status: 400 })
    }
    const body = parsedBody as Record<string, unknown>

    const optionalTextFields = [
      ['mediaId', body.mediaId],
      ['mediaUrl', body.mediaUrl],
      ['mediaCaption', body.mediaCaption],
      ['keywords', body.keywords],
      ['publicReply', body.publicReply],
      ['activeHoursStart', body.activeHoursStart],
      ['activeHoursEnd', body.activeHoursEnd],
      ['autoTag', body.autoTag],
    ] as const
    const invalidTextField = findInvalidOptionalTextField(optionalTextFields)
    if (invalidTextField) {
      return NextResponse.json(
        { error: `O campo ${invalidTextField} deve ser um texto.` },
        { status: 400 },
      )
    }
    if (typeof body.autoTag === 'string' && body.autoTag.trim().length > MAX_TAG_LENGTH) {
      return NextResponse.json({ error: `A tag pode ter no máximo ${MAX_TAG_LENGTH} caracteres.` }, { status: 400 })
    }

    const [current] = await db
      .select()
      .from(instagramCommentAutomations)
      .where(and(eq(instagramCommentAutomations.id, automationId), eq(instagramCommentAutomations.companyId, company.id)))
      .limit(1)
    if (!current) return NextResponse.json({ error: 'Automação não encontrada' }, { status: 404 })

    const requestedTemplateId = body.templateId === undefined
      ? current.templateId?.trim() || ''
      : typeof body.templateId === 'string' ? body.templateId.trim() : ''
    if (requestedTemplateId && requestedTemplateId !== INSTAGRAM_COMMENT_DM_TEMPLATE_ID) {
      return NextResponse.json({ error: 'templateId não reconhecido.' }, { status: 400 })
    }

    const nextTriggerType = body.triggerType === undefined
      ? (current.triggerType ?? 'comment')
      : body.triggerType
    if (typeof nextTriggerType !== 'string' || !['comment', 'direct', 'both'].includes(nextTriggerType)) {
      return NextResponse.json({ error: 'O gatilho deve ser comentário, Direct ou ambos.' }, { status: 400 })
    }
    const nextMatchType = body.matchType === undefined ? current.matchType : body.matchType
    if ((nextTriggerType === 'direct' || nextTriggerType === 'both') && nextMatchType === 'any') {
      return NextResponse.json({ error: 'O gatilho por palavra no Direct não aceita “Qualquer comentário”. Escolha contém ou exato.' }, { status: 400 })
    }
    const nextRequireFollowCheck = body.requireFollowCheck === undefined ? current.requireFollowCheck : body.requireFollowCheck
    if (nextTriggerType === 'direct' && nextRequireFollowCheck === true) {
      return NextResponse.json({ error: 'O gatilho só por Direct não permite exigir que a pessoa siga a conta.' }, { status: 400 })
    }
    const nextPublicReply = body.publicReply === undefined ? current.publicReply : body.publicReply
    const nextHideComment = body.hideCommentAfterReply === undefined ? current.hideCommentAfterReply : body.hideCommentAfterReply
    if (nextTriggerType === 'direct' && ((typeof nextPublicReply === 'string' && nextPublicReply.trim()) || nextHideComment === true)) {
      return NextResponse.json({ error: 'O gatilho só por Direct não permite resposta pública nem ocultar comentário.' }, { status: 400 })
    }
    if (requestedTemplateId && nextTriggerType !== 'comment') {
      return NextResponse.json({ error: 'O template 021126 só pode usar o gatilho de comentário.' }, { status: 400 })
    }

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    }

    if (typeof body.name === 'string') updateData.name = body.name.trim()
    if (body.triggerType !== undefined) updateData.triggerType = nextTriggerType
    if (body.mediaId !== undefined) updateData.mediaId = typeof body.mediaId === 'string' ? body.mediaId.trim() || null : null
    if (body.mediaUrl !== undefined) updateData.mediaUrl = typeof body.mediaUrl === 'string' ? body.mediaUrl.trim() || null : null
    if (body.mediaCaption !== undefined) updateData.mediaCaption = typeof body.mediaCaption === 'string' ? body.mediaCaption.trim() || null : null
    if (body.keywords !== undefined) updateData.keywords = typeof body.keywords === 'string' ? body.keywords.trim() || null : null
    if (typeof body.matchType === 'string' && ['contains', 'exact', 'any'].includes(body.matchType)) {
      updateData.matchType = body.matchType
    }
    if (typeof body.dmMessage === 'string') updateData.dmMessage = body.dmMessage.trim()
    if (body.publicReply !== undefined) updateData.publicReply = typeof body.publicReply === 'string' ? body.publicReply.trim() || null : null
    if (typeof body.hideCommentAfterReply === 'boolean') updateData.hideCommentAfterReply = body.hideCommentAfterReply
    if (body.activeHoursStart !== undefined) updateData.activeHoursStart = typeof body.activeHoursStart === 'string' ? body.activeHoursStart.trim() || null : null
    if (body.activeHoursEnd !== undefined) updateData.activeHoursEnd = typeof body.activeHoursEnd === 'string' ? body.activeHoursEnd.trim() || null : null
    if (typeof body.isActive === 'boolean') updateData.isActive = body.isActive
    if (typeof body.requireFollowCheck === 'boolean') updateData.requireFollowCheck = body.requireFollowCheck
    if (body.autoTag !== undefined) updateData.autoTag = typeof body.autoTag === 'string' ? normalizeTag(body.autoTag) || null : null

    if (nextTriggerType === 'direct') {
      updateData.mediaId = null
      updateData.mediaUrl = null
      updateData.mediaCaption = null
    }

    if (requestedTemplateId === INSTAGRAM_COMMENT_DM_TEMPLATE_ID) {
      const nextMediaId = body.mediaId !== undefined
        ? typeof body.mediaId === 'string' ? body.mediaId.trim() || null : null
        : current.mediaId
      const nextIsActive = typeof body.isActive === 'boolean' ? body.isActive : Boolean(current.isActive)
      if (typeof body.publicReply === 'string' && body.publicReply.trim()) {
        return NextResponse.json({ error: 'O template 021126 não publica resposta em comentário.' }, { status: 400 })
      }
      if (body.hideCommentAfterReply === true) {
        return NextResponse.json({ error: 'O template 021126 não oculta comentários.' }, { status: 400 })
      }
      let registration: ReturnType<typeof buildInstagramCommentDmTemplateRegistration>
      try {
        registration = buildInstagramCommentDmTemplateRegistration({ mediaId: nextMediaId, isActive: nextIsActive })
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Registro de template inválido.' }, { status: 400 })
      }
      if (typeof body.dmMessage === 'string' && body.dmMessage.trim() && body.dmMessage.trim() !== registration.dmMessage) {
        return NextResponse.json({ error: 'A mensagem do template 021126 é fixa e não pode ser alterada.' }, { status: 400 })
      }
      updateData.name = registration.name
      updateData.mediaId = registration.mediaId
      updateData.keywords = registration.keywords
      updateData.matchType = registration.matchType
      updateData.dmMessage = registration.dmMessage
      updateData.publicReply = null
      updateData.hideCommentAfterReply = false
      updateData.isActive = registration.isActive
      updateData.templateId = registration.templateId
      updateData.templateVariables = registration.templateVariables
      updateData.consentRequired = registration.consentRequired
      updateData.metaWindowHours = registration.metaWindowHours
      updateData.apiOrigin = registration.apiOrigin
    }

    const [updated] = await db
      .update(instagramCommentAutomations)
      .set(updateData)
      .where(
        and(
          eq(instagramCommentAutomations.id, automationId),
          eq(instagramCommentAutomations.companyId, company.id)
        )
      )
      .returning()

    if (!updated) {
      return NextResponse.json({ error: 'Automação não encontrada' }, { status: 404 })
    }

    return NextResponse.json({ automation: updated })
  } catch (err: unknown) {
    if (isUnauthorizedError(err)) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    if (isForbiddenError(err)) return forbiddenResponse()
    console.error('[Comment Automation PATCH Error]:', err)
    return NextResponse.json({ error: 'Erro interno ao atualizar' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const { company } = await requireCompanyRole('admin')
    const { id } = await params
    const automationId = parseInt(id, 10)

    if (isNaN(automationId)) {
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    const [deleted] = await db
      .delete(instagramCommentAutomations)
      .where(
        and(
          eq(instagramCommentAutomations.id, automationId),
          eq(instagramCommentAutomations.companyId, company.id)
        )
      )
      .returning()

    if (!deleted) {
      return NextResponse.json({ error: 'Automação não encontrada' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    if (isUnauthorizedError(err)) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    if (isForbiddenError(err)) return forbiddenResponse()
    console.error('[Comment Automation DELETE Error]:', err)
    return NextResponse.json({ error: 'Erro interno ao excluir' }, { status: 500 })
  }
}
