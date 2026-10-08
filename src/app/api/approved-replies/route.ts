export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sacApprovedReplies } from '@/lib/db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'

function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const company = await requireCompany()

    const { searchParams } = new URL(req.url)
    const state = searchParams.get('state') // 'approved' | 'draft' | 'all'

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
  } catch (err: any) {
    return noStoreJson({ error: err.message || 'Erro ao listar respostas aprovadas' }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const company = await requireCompany()

    const body = await req.json().catch(() => null)
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
    let parsedVariables = Array.isArray(variables) ? variables.map(String) : []
    if (parsedVariables.length === 0) {
      const matches = contentBody.match(/\{([a-zA-Z0-9_]+)\}/g)
      if (matches) {
        parsedVariables = Array.from(new Set(matches.map((m: string) => m.replace(/[{}]/g, ''))))
      }
    }

    const state = approvalState === 'draft' || approvalState === 'deprecated' ? approvalState : 'approved'

    const [reply] = await db
      .insert(sacApprovedReplies)
      .values({
        companyId: company.id,
        title: title.trim(),
        shortcut: cleanShortcut,
        body: contentBody.trim(),
        variables: parsedVariables,
        approvalState: state,
        approvedBy: state === 'approved' ? company.agentDisplayName || 'Administrador' : null,
        approvedAt: state === 'approved' ? new Date() : null,
      })
      .returning()

    return noStoreJson({ success: true, reply }, { status: 201 })
  } catch (err: any) {
    // Tratar colisão de atalho único por empresa
    if (err?.code === '23505' || err?.message?.includes('unique')) {
      return noStoreJson({ error: 'Já existe uma resposta com este atalho para esta empresa.' }, { status: 409 })
    }
    return noStoreJson({ error: err.message || 'Erro ao criar resposta aprovada' }, { status: 500 })
  }
}
