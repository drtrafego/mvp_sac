import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { instagramCommentAutomations } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompanyRole, AuthError, ForbiddenError, forbiddenResponse } from '@/lib/auth'
import { findInvalidOptionalTextField } from '@/lib/request-validation'
import { MAX_TAG_LENGTH, normalizeTag } from '@/lib/lead-tags'

interface RouteContext {
  params: Promise<{ id: string }>
}
function isForbiddenError(error: unknown): boolean { return error instanceof ForbiddenError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 403) }

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
  } catch (err: any) {
    if (err instanceof AuthError || err?.status === 401) {
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

    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    }

    if (typeof body.name === 'string') updateData.name = body.name.trim()
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
  } catch (err: any) {
    if (err instanceof AuthError || err?.status === 401) {
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
  } catch (err: any) {
    if (err instanceof AuthError || err?.status === 401) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    if (isForbiddenError(err)) return forbiddenResponse()
    console.error('[Comment Automation DELETE Error]:', err)
    return NextResponse.json({ error: 'Erro interno ao excluir' }, { status: 500 })
  }
}
