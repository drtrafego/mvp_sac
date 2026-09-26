export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { leadTags, recoveryLeads } from '@/lib/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { requireCompany, getCurrentUser } from '@/lib/auth'
import { normalizeTag, validateTagScope, PESSOA_TAG, BOT_PAUSED_BY_TAG_PESSOA, MAX_TAG_LENGTH } from '@/lib/lead-tags'
import { notifyNaoResponder } from '@/lib/nao-responder'

type Params = { params: Promise<{ leadId: string }> }

/**
 * GET /api/leads/[leadId]/tags
 * Lista todas as tags do lead, mais recente primeiro.
 */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { leadId } = await params
    const id = parseInt(leadId, 10)
    if (isNaN(id)) return NextResponse.json({ error: 'ID de lead inválido' }, { status: 400 })

    const company = await requireCompany()

    const [lead] = await db
      .select({ id: recoveryLeads.id })
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

    if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

    const tags = await db
      .select()
      .from(leadTags)
      .where(eq(leadTags.leadId, id))
      .orderBy(desc(leadTags.createdAt))

    return NextResponse.json({ tags })
  } catch (err) {
    console.error('[API /leads/[leadId]/tags GET] Erro:', err)
    return NextResponse.json({ error: 'Erro ao carregar tags' }, { status: 500 })
  }
}

/**
 * POST /api/leads/[leadId]/tags
 * Body: { tag: string, scopeChannel?: string | null }
 * Adiciona uma nova tag ao lead com validação de escopo de canal.
 * Se a tag for "pessoa", força escopo geral (null), pausa o bot de IA e notifica a ponte externa.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { leadId } = await params
    const id = parseInt(leadId, 10)
    if (isNaN(id)) return NextResponse.json({ error: 'ID de lead inválido' }, { status: 400 })

    const company = await requireCompany()
    const user = await getCurrentUser()

    const body = await req.json().catch(() => ({}))
    const rawTag = body.tag || body.name || ''
    const normTag = normalizeTag(rawTag)

    if (!normTag) {
      return NextResponse.json({ error: `Nome da tag é obrigatório (máx. ${MAX_TAG_LENGTH} caracteres)` }, { status: 400 })
    }

    const [lead] = await db
      .select()
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

    if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

    const rawScope = body.scopeChannel as string | null | undefined
    const finalScope = normTag === PESSOA_TAG ? null : (rawScope?.trim() || null)

    if (finalScope) {
      const scopeVal = validateTagScope(finalScope, lead.channel)
      if (!scopeVal.valid) {
        return NextResponse.json({ error: scopeVal.error }, { status: 400 })
      }
    }

    const createdBy = user?.displayName || user?.primaryEmail || 'Atendente humano'

    const [createdTag] = await db
      .insert(leadTags)
      .values({
        leadId: lead.id,
        tag: normTag,
        scopeChannel: finalScope,
        createdBy,
      })
      .onConflictDoNothing()
      .returning()

    let warning: string | undefined

    if (normTag === PESSOA_TAG) {
      const now = new Date()
      await db
        .update(recoveryLeads)
        .set({
          botPaused: true,
          botPausedAt: now,
          botPausedBy: `Atendente humano (${createdBy}) - ${BOT_PAUSED_BY_TAG_PESSOA}`,
          botPausedAll: false,
          botPausedChannel: null,
          updatedAt: now,
        })
        .where(eq(recoveryLeads.id, lead.id))

      const result = await notifyNaoResponder({
        phone: lead.phone,
        action: 'pause',
        reason: `Tag pessoa adicionada por ${createdBy}`,
        channel: lead.channel || 'whatsapp',
      })
      if (!result.ok) warning = result.warning
    }

    const tags = await db
      .select()
      .from(leadTags)
      .where(eq(leadTags.leadId, id))
      .orderBy(desc(leadTags.createdAt))

    return NextResponse.json({
      ok: true,
      tag: createdTag || { leadId: id, tag: normTag, scopeChannel: finalScope, createdBy },
      tags,
      warning,
    })
  } catch (err) {
    console.error('[API /leads/[leadId]/tags POST] Erro:', err)
    return NextResponse.json({ error: 'Erro ao adicionar tag' }, { status: 500 })
  }
}
