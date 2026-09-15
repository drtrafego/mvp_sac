export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, settings } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const [companySettings] = await db
    .select()
    .from(settings)
    .where(eq(settings.companyId, context.company.id))

  return NextResponse.json({
    ok: true,
    company: context.company,
    settings: companySettings || null,
  })
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  try {
    const body = await req.json()
    const updateData: Record<string, any> = { updatedAt: new Date() }

    if (body.name !== undefined) updateData.name = String(body.name).trim()
    if (body.slug !== undefined) {
      updateData.slug = String(body.slug).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    }
    if (body.plan !== undefined) updateData.plan = body.plan

    const [updated] = await db
      .update(companies)
      .set(updateData)
      .where(eq(companies.id, context.company.id))
      .returning()

    return NextResponse.json({ ok: true, company: updated })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Erro ao atualizar empresa' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  try {
    await db.delete(companies).where(eq(companies.id, context.company.id))
    return NextResponse.json({ ok: true, message: `Empresa ${context.company.name} (${context.company.slug}) excluída com sucesso` })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Erro ao excluir empresa' }, { status: 500 })
  }
}
