import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { instagramCommentAutomations } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompany, AuthError } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const company = await requireCompany()
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
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: RouteContext) {
  try {
    const company = await requireCompany()
    const { id } = await params
    const automationId = parseInt(id, 10)

    if (isNaN(automationId)) {
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    const body = await req.json().catch(() => ({}))
    const updateData: Record<string, unknown> = {
      updatedAt: new Date(),
    }

    if (typeof body.name === 'string') updateData.name = body.name.trim()
    if (body.mediaId !== undefined) updateData.mediaId = body.mediaId?.trim() || null
    if (body.mediaUrl !== undefined) updateData.mediaUrl = body.mediaUrl?.trim() || null
    if (body.mediaCaption !== undefined) updateData.mediaCaption = body.mediaCaption?.trim() || null
    if (body.keywords !== undefined) updateData.keywords = body.keywords?.trim() || null
    if (['contains', 'exact', 'any'].includes(body.matchType)) updateData.matchType = body.matchType
    if (typeof body.dmMessage === 'string') updateData.dmMessage = body.dmMessage.trim()
    if (body.publicReply !== undefined) updateData.publicReply = body.publicReply?.trim() || null
    if (typeof body.hideCommentAfterReply === 'boolean') updateData.hideCommentAfterReply = body.hideCommentAfterReply
    if (body.activeHoursStart !== undefined) updateData.activeHoursStart = body.activeHoursStart?.trim() || null
    if (body.activeHoursEnd !== undefined) updateData.activeHoursEnd = body.activeHoursEnd?.trim() || null
    if (typeof body.isActive === 'boolean') updateData.isActive = body.isActive
    if (typeof body.requireFollowCheck === 'boolean') updateData.requireFollowCheck = body.requireFollowCheck

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
    console.error('[Comment Automation PATCH Error]:', err)
    return NextResponse.json({ error: 'Erro interno ao atualizar' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: RouteContext) {
  try {
    const company = await requireCompany()
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
    console.error('[Comment Automation DELETE Error]:', err)
    return NextResponse.json({ error: 'Erro interno ao excluir' }, { status: 500 })
  }
}
