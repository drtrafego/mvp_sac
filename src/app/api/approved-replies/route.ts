export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sacApprovedReplies } from '@/lib/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { getCompanyAccess, requireSacActor, ForbiddenError, AuthError } from '@/lib/auth'
import { authenticateAgentRequest, logAgentActivity } from '@/lib/agent-auth'
import { roleSatisfies } from '@/lib/company-role'
import { parseSacObject, SacInputError, isUniqueConstraintError } from '@/lib/sac-access'

function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

async function otoniContext(req: NextRequest) {
  if (!req.headers.get('authorization') && !req.headers.get('x-api-key')) return null
  const result = await authenticateAgentRequest(req, '25394')
  if (result.error) return { error: result.error }
  if (result.context?.restrictedProfile !== 'flavio-otoni' || result.context.company.id !== 25394) {
    return { error: noStoreJson({ error: 'Operação fora do escopo autorizado.', code: 'SCOPE_DENIED' }, { status: 403 }) }
  }
  return { context: result.context }
}

function validateOtoniPayload(body: Record<string, unknown>, req: NextRequest) {
  const tenant = body.tenantId ?? body.companyId
  if (tenant !== undefined && String(tenant) !== '25394') throw new SacInputError('Tenant inválido.', 403)
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 300) throw new SacInputError('Nome inválido.')
  if (typeof body.body !== 'string' || !body.body.trim() || body.body.length > 64000) throw new SacInputError('Conteúdo inválido.')
  if (body.approvalState !== undefined && body.approvalState !== 'draft') throw new SacInputError('Este agente só pode salvar variáveis em rascunho.', 403)
  if (body.variables !== undefined && (!Array.isArray(body.variables) || body.variables.some((v) => typeof v !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v)))) throw new SacInputError('Variáveis inválidas.')
  const key = req.headers.get('idempotency-key') || (typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '')
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new SacInputError('Idempotency-Key obrigatório e inválido.')
  return { key, title: body.title.trim(), content: body.body.trim(), shortcut: typeof body.shortcut === 'string' && body.shortcut.trim() ? (body.shortcut.trim().startsWith('/') ? body.shortcut.trim() : `/${body.shortcut.trim()}`) : null, variables: Array.isArray(body.variables) ? [...new Set(body.variables as string[])] : [...new Set(body.body.match(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)?.map((v) => v.slice(1, -1)) ?? [])] }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const otoni = await otoniContext(req)
    if (otoni?.error) return otoni.error
    if (otoni?.context) {
      const requestedTenant = new URL(req.url).searchParams.get('tenantId') || new URL(req.url).searchParams.get('companyId')
      if (requestedTenant && requestedTenant !== '25394') return noStoreJson({ error: 'Tenant inválido.', code: 'SCOPE_DENIED' }, { status: 403 })
      const replies = await db.select().from(sacApprovedReplies).where(and(eq(sacApprovedReplies.companyId, 25394), eq(sacApprovedReplies.approvalState, 'approved'))).orderBy(desc(sacApprovedReplies.updatedAt))
      await logAgentActivity({ companyId: 25394, agentId: otoni.context.agentId, agentName: otoni.context.agentName, action: 'agent.approved_replies.read', entityType: 'approved_replies', entityId: '25394', details: { tenantId: 25394, operation: 'list', resource: 'approved_replies', result: 'success', count: replies.length } })
      return noStoreJson({ ok: true, replies })
    }
    const { company, role } = await getCompanyAccess()

    const { searchParams } = new URL(req.url)
    const state = searchParams.get('state') || 'approved'
    if (!['approved', 'draft', 'deprecated', 'all'].includes(state)) return noStoreJson({ error: 'Estado inválido.' }, { status: 400 })
    if (state !== 'approved' && !roleSatisfies(role, 'admin')) return noStoreJson({ error: 'Somente administradores podem consultar respostas em revisão.' }, { status: 403 })

    const conditions = [eq(sacApprovedReplies.companyId, company.id)]
    if (state && state !== 'all') {
      conditions.push(eq(sacApprovedReplies.approvalState, state))
    }

    const replies = await db
      .select()
      .from(sacApprovedReplies)
      .where(and(...conditions))
      .orderBy(desc(sacApprovedReplies.updatedAt))

    return noStoreJson({ replies })
  } catch (err: unknown) {
    if (err instanceof SacInputError || err instanceof ForbiddenError || err instanceof AuthError) return noStoreJson({ error: err.message }, { status: err.status })
    return noStoreJson({ error: 'Erro ao listar respostas aprovadas' }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const otoni = await otoniContext(req)
    if (otoni?.error) return otoni.error
    if (otoni?.context) {
      const body = parseSacObject(await req.json().catch(() => null))
      const input = validateOtoniPayload(body, req)
      const values = { companyId: 25394, title: input.title, shortcut: input.shortcut, body: input.content, variables: input.variables, approvalState: 'draft', idempotencyKey: input.key }
      const [created] = await db.insert(sacApprovedReplies).values(values).onConflictDoNothing({ target: [sacApprovedReplies.companyId, sacApprovedReplies.idempotencyKey] }).returning()
      const [reply] = created ? [created] : await db.select().from(sacApprovedReplies).where(and(eq(sacApprovedReplies.companyId, 25394), eq(sacApprovedReplies.idempotencyKey, input.key))).limit(1)
      if (!reply) throw new Error('Idempotency replay could not be resolved')
      await logAgentActivity({ companyId: 25394, agentId: otoni.context.agentId, agentName: otoni.context.agentName, action: 'agent.approved_replies.write', entityType: 'approved_replies', entityId: String(reply.id), details: { tenantId: 25394, operation: 'save', resource: 'approved_replies', result: created ? 'success' : 'idempotent_replay' } })
      return noStoreJson({ ok: true, idempotentReplay: !created, reply }, { status: created ? 201 : 200 })
    }
    const { company, role, actorName } = await requireSacActor()

    const body = parseSacObject(await req.json().catch(() => null))
    if (!body || typeof body !== 'object') {
      return noStoreJson({ error: 'Corpo da requisição inválido' }, { status: 400 })
    }

    const { title, shortcut, body: contentBody, variables, approvalState } = body

    if (!title || typeof title !== 'string' || !title.trim()) {
      return noStoreJson({ error: 'O título da resposta é obrigatório.' }, { status: 400 })
    }
    if (!contentBody || typeof contentBody !== 'string' || !contentBody.trim()) {
      return noStoreJson({ error: 'O conteúdo da resposta é obrigatório.' }, { status: 400 })
    }

    let cleanShortcut = typeof shortcut === 'string' && shortcut.trim() ? shortcut.trim() : null
    if (cleanShortcut && !cleanShortcut.startsWith('/')) {
      cleanShortcut = `/${cleanShortcut}`
    }

    // Extrair automaticamente variáveis como {nome}, {prazo}, etc., se não fornecidas explicitamente
    if (variables !== undefined && (!Array.isArray(variables) || variables.some((v) => typeof v !== 'string'))) throw new SacInputError('Variáveis inválidas.')
    let parsedVariables: string[] = Array.isArray(variables) ? variables : []
    if (parsedVariables.length === 0) {
      const matches = contentBody.match(/\{([a-zA-Z0-9_]+)\}/g)
      if (matches) {
        parsedVariables = Array.from(new Set(matches.map((m: string) => m.replace(/[{}]/g, ''))))
      }
    }

    if (approvalState !== undefined && !['draft', 'approved', 'deprecated'].includes(String(approvalState))) throw new SacInputError('Estado de aprovação inválido.')
    const state = approvalState === undefined ? (roleSatisfies(role, 'admin') ? 'approved' : 'draft') : String(approvalState)
    if (state !== 'draft' && !roleSatisfies(role, 'admin')) throw new ForbiddenError('Somente administradores podem aprovar ou retirar respostas.')

    const [reply] = await db
      .insert(sacApprovedReplies)
      .values({
        companyId: company.id,
        title: title.trim(),
        shortcut: cleanShortcut,
        body: contentBody.trim(),
        variables: parsedVariables,
        approvalState: state,
        approvedBy: state === 'approved' ? actorName : null,
        approvedAt: state === 'approved' ? new Date() : null,
      })
      .returning()

    return noStoreJson({ success: true, reply }, { status: 201 })
  } catch (err: unknown) {
    if (err instanceof SacInputError || err instanceof ForbiddenError || err instanceof AuthError) return noStoreJson({ error: err.message }, { status: err.status })
    // Tratar colisão de atalho único por empresa
    if (isUniqueConstraintError(err)) {
      return noStoreJson({ error: 'Já existe uma resposta com este atalho para esta empresa.' }, { status: 409 })
    }
    return noStoreJson({ error: 'Erro ao criar resposta aprovada' }, { status: 500 })
  }
}
