import { NextRequest, NextResponse } from 'next/server'
import { requireSacActor, ForbiddenError, AuthError } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, and, sql, type SQL } from 'drizzle-orm'
import { parseSacObject, parsePositiveId, parseExpectedVersion, validateSacContextFields, sacEpisodeForState, SacInputError } from '@/lib/sac-access'

export const dynamic = 'force-dynamic'

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const id = parsePositiveId((await params).leadId, 'Lead')
    const { company, actorName } = await requireSacActor()
    const body = parseSacObject(await req.json().catch(() => null))
    const [lead] = await db.select().from(recoveryLeads).where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
    if (!lead) return NextResponse.json({ error: 'Lead não encontrado.' }, { status: 404 })
    const newContextFields = ['humanOwnerMemberId', 'nextActionDueAt', 'requestSummary', 'requestMessageId', 'commitment', 'nextAction', 'sacCaseState']
    const needsVersion = newContextFields.some((key) => body[key] !== undefined)
    const expected = body.expectedContextVersion !== undefined || needsVersion ? parseExpectedVersion(body.expectedContextVersion) : null
    const contextBody = { ...body, ...(body.stage !== undefined ? { pipelineStage: body.stage || 'novo_contato' } : {}) }
    const updateData: Partial<{ [K in keyof typeof recoveryLeads.$inferInsert]: typeof recoveryLeads.$inferInsert[K] | SQL }> = await validateSacContextFields(contextBody, lead)
    if (typeof updateData.sacCaseState === 'string') updateData.sacCaseEpisode = sacEpisodeForState(updateData.sacCaseState)
    for (const key of ['name', 'phone', 'email', 'productName', 'trackingSource'] as const) {
      if (body[key] !== undefined) {
        if (body[key] !== null && typeof body[key] !== 'string') throw new SacInputError(`${key} deve ser texto.`)
        if (key === 'phone') {
          if (typeof body[key] !== 'string' || !body[key].trim()) throw new SacInputError('Telefone obrigatório.')
          updateData.phone = body[key].trim()
        } else updateData[key] = typeof body[key] === 'string' ? body[key].trim() || null : null
      }
    }
    if (body.productValue !== undefined) {
      if (body.productValue !== null && (typeof body.productValue !== 'number' || !Number.isFinite(body.productValue))) throw new SacInputError('Valor do produto inválido.')
      updateData.productValue = body.productValue === null ? null : Math.round(body.productValue as number)
    }
    if (!Object.keys(updateData).length) throw new SacInputError('Nenhum campo alterado foi informado.')
    updateData.updatedAt = new Date()
    updateData.lastActionBy = actorName
    updateData.lastActionAt = new Date()
    updateData.contextVersion = sql`coalesce(${recoveryLeads.contextVersion}, 1) + 1`
    const [updated] = await db.update(recoveryLeads).set(updateData).where(and(
      eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id),
      expected !== null ? sql`coalesce(${recoveryLeads.contextVersion}, 1) = ${expected}` : undefined,
    )).returning()
    if (!updated) return NextResponse.json({ error: 'Este atendimento foi alterado. Atualize antes de salvar.', code: 'CONTEXT_CONFLICT' }, { status: 409 })
    return NextResponse.json({ success: true, lead: updated })
  } catch (error: unknown) {
    if (error instanceof SacInputError || error instanceof ForbiddenError || error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.status })
    return NextResponse.json({ error: 'Erro ao atualizar lead.' }, { status: 500 })
  }
}
