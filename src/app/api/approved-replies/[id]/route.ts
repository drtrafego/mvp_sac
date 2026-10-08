export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sacApprovedReplies } from '@/lib/db/schema'
import { eq, and, sql, type SQL } from 'drizzle-orm'
import { getCompanyAccess, requireSacActor, ForbiddenError, AuthError } from '@/lib/auth'
import { roleSatisfies } from '@/lib/company-role'
import { parseSacObject, parseExpectedVersion, SacInputError, isUniqueConstraintError } from '@/lib/sac-access'

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

    const { company, role } = await getCompanyAccess()

    const [reply] = await db
      .select()
      .from(sacApprovedReplies)
      .where(and(eq(sacApprovedReplies.id, replyId), eq(sacApprovedReplies.companyId, company.id)))

    if (!reply) {
      return noStoreJson({ error: 'Resposta aprovada não encontrada' }, { status: 404 })
    }

    if (reply.approvalState !== 'approved' && !roleSatisfies(role, 'admin')) throw new ForbiddenError()
    return noStoreJson({ reply })
  } catch (err: unknown) {
    if (err instanceof SacInputError || err instanceof ForbiddenError || err instanceof AuthError) return noStoreJson({ error: err.message }, { status: err.status })
    return noStoreJson({ error: 'Erro ao buscar resposta aprovada' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { id } = await params
    const replyId = Number(id)
    if (!Number.isSafeInteger(replyId) || replyId <= 0) throw new SacInputError('ID inválido.')
    const { company, role, actorName } = await requireSacActor()
    const body = parseSacObject(await req.json().catch(() => null))
    const expected = parseExpectedVersion(body.expectedVersion)
    const [existing] = await db.select().from(sacApprovedReplies).where(and(eq(sacApprovedReplies.id, replyId), eq(sacApprovedReplies.companyId, company.id)))
    if (!existing) return noStoreJson({ error: 'Resposta não encontrada.' }, { status: 404 })
    if (!roleSatisfies(role, 'admin')) throw new ForbiddenError('Somente administradores podem revisar respostas da empresa.')
    const update: Partial<{ [K in keyof typeof sacApprovedReplies.$inferInsert]: typeof sacApprovedReplies.$inferInsert[K] | SQL }> = { updatedAt: new Date(), version: sql`${sacApprovedReplies.version} + 1` }
    for (const key of ['title', 'body'] as const) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'string' || !body[key].trim()) throw new SacInputError(`${key} deve ser texto não vazio.`)
        update[key] = body[key].trim()
      }
    }
    if (body.shortcut !== undefined) {
      if (body.shortcut !== null && typeof body.shortcut !== 'string') throw new SacInputError('Atalho inválido.')
      const shortcut = typeof body.shortcut === 'string' ? body.shortcut.trim() : ''
      update.shortcut = shortcut ? (shortcut.startsWith('/') ? shortcut : `/${shortcut}`) : null
    }
    if (body.variables !== undefined) {
      if (!Array.isArray(body.variables) || body.variables.some((v) => typeof v !== 'string')) throw new SacInputError('Variáveis inválidas.')
      update.variables = body.variables
    } else if (body.body !== undefined) {
      update.variables = [...new Set(String(body.body).match(/\{([a-zA-Z0-9_]+)\}/g)?.map((v) => v.slice(1, -1)) ?? [])]
    }
    const changedContent = ['title', 'body', 'shortcut', 'variables'].some((key) => body[key] !== undefined)
    const state = body.approvalState ?? (changedContent ? 'draft' : existing.approvalState)
    if (typeof state !== 'string' || !['draft', 'approved', 'deprecated'].includes(state)) throw new SacInputError('Estado de aprovação inválido.')
    update.approvalState = state
    update.approvedBy = state === 'approved' ? actorName : null
    update.approvedAt = state === 'approved' ? new Date() : null
    const [updated] = await db.update(sacApprovedReplies).set(update)
      .where(and(eq(sacApprovedReplies.id, replyId), eq(sacApprovedReplies.companyId, company.id), eq(sacApprovedReplies.version, expected))).returning()
    if (!updated) return noStoreJson({ error: 'A resposta foi alterada por outra pessoa. Atualize antes de salvar.', code: 'VERSION_CONFLICT' }, { status: 409 })
    return noStoreJson({ success: true, reply: updated })
  } catch (err: unknown) {
    if (err instanceof SacInputError || err instanceof ForbiddenError || err instanceof AuthError) return noStoreJson({ error: err.message }, { status: err.status })
    if (isUniqueConstraintError(err)) return noStoreJson({ error: 'Já existe uma resposta com este atalho.' }, { status: 409 })
    return noStoreJson({ error: 'Erro ao atualizar resposta.' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { id } = await params
    const replyId = parseInt(id)
    if (isNaN(replyId)) return noStoreJson({ error: 'ID inválido' }, { status: 400 })

    const { company, role } = await getCompanyAccess()
    if (!roleSatisfies(role, 'admin')) throw new ForbiddenError()

    const body = await req.json().catch(() => ({}))
    const expected = parseExpectedVersion(new URL(req.url).searchParams.get('expectedVersion') ?? body.expectedVersion)
    const [deleted] = await db
      .delete(sacApprovedReplies)
      .where(and(eq(sacApprovedReplies.id, replyId), eq(sacApprovedReplies.companyId, company.id), eq(sacApprovedReplies.version, expected)))
      .returning()

    if (!deleted) {
      return noStoreJson({ error: 'Resposta removida ou alterada por outra pessoa.' }, { status: 409 })
    }

    return noStoreJson({ success: true, id: replyId })
  } catch (err: unknown) {
    if (err instanceof SacInputError || err instanceof ForbiddenError || err instanceof AuthError) return noStoreJson({ error: err.message }, { status: err.status })
    return noStoreJson({ error: 'Erro ao excluir resposta aprovada' }, { status: 500 })
  }
}
