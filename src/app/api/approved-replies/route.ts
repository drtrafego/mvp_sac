export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sacApprovedReplies } from '@/lib/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { getCompanyAccess, requireSacActor, ForbiddenError, AuthError } from '@/lib/auth'
import { roleSatisfies } from '@/lib/company-role'
import { parseSacObject, SacInputError, isUniqueConstraintError } from '@/lib/sac-access'

function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
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
