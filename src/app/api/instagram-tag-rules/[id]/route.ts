import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { requireCompanyRole, AuthError, ForbiddenError, forbiddenResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { instagramInboundTagRules } from '@/lib/db/schema'
import { MAX_TAG_LENGTH, normalizeTag } from '@/lib/lead-tags'

type Context = { params: Promise<{ id: string }> }
function unauthorized(error: unknown) { return error instanceof AuthError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 401) }
function isForbidden(error: unknown) { return error instanceof ForbiddenError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 403) }

export async function PATCH(req: NextRequest, { params }: Context) {
  try {
    const { company } = await requireCompanyRole('admin'); const { id } = await params; const ruleId = Number(id)
    if (!Number.isInteger(ruleId)) return NextResponse.json({ error: 'ID inválido.' }, { status: 400 })
    const body: unknown = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'O corpo deve ser um objeto JSON.' }, { status: 400 })
    const value = body as Record<string, unknown>; const update: Record<string, unknown> = { updatedAt: new Date() }
    if (typeof value.name === 'string' && value.name.trim()) update.name = value.name.trim()
    if (typeof value.tag === 'string') {
      const rawTag = value.tag.trim()
      if (!rawTag || rawTag.length > MAX_TAG_LENGTH) return NextResponse.json({ error: `A tag deve ter entre 1 e ${MAX_TAG_LENGTH} caracteres.` }, { status: 400 })
      update.tag = normalizeTag(rawTag)
    }
    if (typeof value.keywords === 'string' || value.keywords === null) update.keywords = typeof value.keywords === 'string' ? value.keywords.trim() || null : null
    if (value.trigger === 'direct' || value.trigger === 'story_reply') update.trigger = value.trigger
    if (value.matchType === 'contains' || value.matchType === 'exact' || value.matchType === 'any') update.matchType = value.matchType
    if (typeof value.isActive === 'boolean') update.isActive = value.isActive
    const [rule] = await db.update(instagramInboundTagRules).set(update).where(and(eq(instagramInboundTagRules.id, ruleId), eq(instagramInboundTagRules.companyId, company.id))).returning()
    if (!rule) return NextResponse.json({ error: 'Regra não encontrada.' }, { status: 404 })
    return NextResponse.json({ rule })
  } catch (error) { if (unauthorized(error)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 }); if (isForbidden(error)) return forbiddenResponse(); return NextResponse.json({ error: 'Erro ao atualizar regra.' }, { status: 500 }) }
}

export async function DELETE(_req: NextRequest, { params }: Context) {
  try {
    const { company } = await requireCompanyRole('admin'); const { id } = await params; const ruleId = Number(id)
    if (!Number.isInteger(ruleId)) return NextResponse.json({ error: 'ID inválido.' }, { status: 400 })
    const [rule] = await db.delete(instagramInboundTagRules).where(and(eq(instagramInboundTagRules.id, ruleId), eq(instagramInboundTagRules.companyId, company.id))).returning()
    if (!rule) return NextResponse.json({ error: 'Regra não encontrada.' }, { status: 404 })
    return NextResponse.json({ ok: true })
  } catch (error) { if (unauthorized(error)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 }); if (isForbidden(error)) return forbiddenResponse(); return NextResponse.json({ error: 'Erro ao remover regra.' }, { status: 500 }) }
}
