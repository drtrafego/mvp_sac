import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { instagramCommentLogs, instagramCommentAutomations } from '@/lib/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { requireCompany, AuthError } from '@/lib/auth'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const company = await requireCompany()
    const { id } = await params

    let whereClause = eq(instagramCommentLogs.companyId, company.id)

    if (id !== 'all') {
      const automationId = parseInt(id, 10)
      if (isNaN(automationId)) {
        return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
      }
      whereClause = and(
        eq(instagramCommentLogs.companyId, company.id),
        eq(instagramCommentLogs.automationId, automationId)
      )!
    }

    const logs = await db
      .select({
        id: instagramCommentLogs.id,
        automationId: instagramCommentLogs.automationId,
        automationName: instagramCommentAutomations.name,
        commentId: instagramCommentLogs.commentId,
        commenterId: instagramCommentLogs.commenterId,
        commenterUsername: instagramCommentLogs.commenterUsername,
        mediaId: instagramCommentLogs.mediaId,
        commentText: instagramCommentLogs.commentText,
        matchedKeyword: instagramCommentLogs.matchedKeyword,
        status: instagramCommentLogs.status,
        errorMessage: instagramCommentLogs.errorMessage,
        sentAt: instagramCommentLogs.sentAt,
        createdAt: instagramCommentLogs.createdAt,
      })
      .from(instagramCommentLogs)
      .leftJoin(
        instagramCommentAutomations,
        eq(instagramCommentLogs.automationId, instagramCommentAutomations.id)
      )
      .where(whereClause)
      .orderBy(desc(instagramCommentLogs.createdAt))
      .limit(100)

    return NextResponse.json({ logs })
  } catch (err: any) {
    if (err instanceof AuthError || err?.status === 401) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    console.error('[Comment Logs GET Error]:', err)
    return NextResponse.json({ error: 'Erro interno ao buscar logs' }, { status: 500 })
  }
}
