export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sacApprovedReplies } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'

function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { id } = await params
    const replyId = parseInt(id)
    if (isNaN(replyId)) return noStoreJson({ error: 'ID inválido' }, { status: 400 })

    const company = await requireCompany()

    const [reply] = await db
      .select()
      .from(sacApprovedReplies)
      .where(and(eq(sacApprovedReplies.id, replyId), eq(sacApprovedReplies.companyId, company.id)))

    if (!reply) {
      return noStoreJson({ error: 'Resposta aprovada não encontrada' }, { status: 404 })
    }

    return noStoreJson({ reply })
  } catch (err: any) {
    return noStoreJson({ error: err.message || 'Erro ao buscar resposta aprovada' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { id } = await params
    const replyId = parseInt(id)
    if (isNaN(replyId)) return noStoreJson({ error: 'ID inválido' }, { status: 400 })

    const company = await requireCompany()

    const [existing] = await db
      .select()
      .from(sacApprovedReplies)
      .where(and(eq(sacApprovedReplies.id, replyId), eq(sacApprovedReplies.companyId, company.id)))

    if (!existing) {
      return noStoreJson({ error: 'Resposta aprovada não encontrada' }, { status: 404 })
    }

    const body = (await req.json().catch(() => null)) as Record<string, any> | null
    if (!body || typeof body !== 'object') {
      return noStoreJson({ error: 'Corpo da requisição inválido' }, { status: 400 })
    }

    const updateData: Record<string, any> = {
      updatedAt: new Date(),
      version: existing.version + 1,
    }

    if (body.title !== undefined) updateData.title = String(body.title).trim()
    if (body.body !== undefined) updateData.body = String(body.body).trim()
    if (body.shortcut !== undefined) {
      let sc = body.shortcut ? String(body.shortcut).trim() : null
      if (sc && !sc.startsWith('/')) sc = `/${sc}`
      updateData.shortcut = sc
    }
    if (body.approvalState !== undefined) {
      updateData.approvalState = body.approvalState
      if (body.approvalState === 'approved') {
        updateData.approvedBy = company.agentDisplayName || 'Administrador'
        updateData.approvedAt = new Date()
      }
    }
    if (body.variables !== undefined) {
      updateData.variables = Array.isArray(body.variables) ? body.variables.map(String) : []
    }

    const [updated] = await db
      .update(sacApprovedReplies)
      .set(updateData)
      .where(and(eq(sacApprovedReplies.id, replyId), eq(sacApprovedReplies.companyId, company.id)))
      .returning()

    return noStoreJson({ success: true, reply: updated })
  } catch (err: any) {
    if (err?.code === '23505' || err?.message?.includes('unique')) {
      return noStoreJson({ error: 'Já existe uma resposta com este atalho para esta empresa.' }, { status: 409 })
    }
    return noStoreJson({ error: err.message || 'Erro ao atualizar resposta aprovada' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { id } = await params
    const replyId = parseInt(id)
    if (isNaN(replyId)) return noStoreJson({ error: 'ID inválido' }, { status: 400 })

    const company = await requireCompany()

    const [deleted] = await db
      .delete(sacApprovedReplies)
      .where(and(eq(sacApprovedReplies.id, replyId), eq(sacApprovedReplies.companyId, company.id)))
      .returning()

    if (!deleted) {
      return noStoreJson({ error: 'Resposta aprovada não encontrada' }, { status: 404 })
    }

    return noStoreJson({ success: true, id: replyId })
  } catch (err: any) {
    return noStoreJson({ error: err.message || 'Erro ao excluir resposta aprovada' }, { status: 500 })
  }
}
