import { NextRequest, NextResponse } from 'next/server'
import { requireCompany, getCurrentUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoveryLeads, leadTags } from '@/lib/db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { normalizeTag, validateTagScope } from '@/lib/lead-tags'
import { notifyNaoResponder } from '@/lib/nao-responder'

type Params = { params: Promise<{ leadId: string }> }

/**
 * GET /api/leads/[leadId]/tags
 * Lista todas as tags aplicadas a um lead específico.
 */
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const company = await requireCompany()
    const { leadId } = await params
    const id = parseInt(leadId, 10)
    if (isNaN(id)) {
      return NextResponse.json({ error: 'ID de lead inválido' }, { status: 400 })
    }

    const [lead] = await db
      .select({ id: recoveryLeads.id })
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

    if (!lead) {
      return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })
    }

    const tags = await db
      .select()
      .from(leadTags)
      .where(eq(leadTags.leadId, id))
      .orderBy(leadTags.createdAt)

    return NextResponse.json({ tags })
  } catch (err) {
    console.error('[API /leads/[leadId]/tags GET] Erro:', err)
    return NextResponse.json({ error: 'Erro ao carregar tags' }, { status: 500 })
  }
}

/**
 * POST /api/leads/[leadId]/tags
 * Adiciona uma nova tag ao lead com validação de escopo de canal.
 * Se a tag for "pessoa", força escopo geral (null), pausa o bot de IA e notifica a ponte externa.
 */
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const company = await requireCompany()
    const user = await getCurrentUser()
    const { leadId } = await params
    const id = parseInt(leadId, 10)
    if (isNaN(id)) {
      return NextResponse.json({ error: 'ID de lead inválido' }, { status: 400 })
    }

    const [lead] = await db
      .select()
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

    if (!lead) {
      return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })
    }

    const body = await req.json().catch(() => ({}))
    const rawTag = body.tag || body.name
    const normTag = normalizeTag(rawTag)

    if (!normTag) {
      return NextResponse.json({ error: 'Nome da tag é obrigatório' }, { status: 400 })
    }

    const rawScope = body.scopeChannel as string | null | undefined

    // Regra ITEM 2: Tag "pessoa" é sempre geral (scopeChannel = null)
    const finalScope = normTag === 'pessoa' ? null : (rawScope?.trim() || null)

    if (finalScope) {
      const scopeVal = validateTagScope(finalScope, lead.channel)
      if (!scopeVal.valid) {
        return NextResponse.json({ error: scopeVal.error }, { status: 400 })
      }
    }

    const operatorName = user?.displayName || user?.primaryEmail || 'Atendente humano'

    const [createdTag] = await db
      .insert(leadTags)
      .values({
        leadId: lead.id,
        tag: normTag,
        scopeChannel: finalScope,
        createdBy: operatorName,
      })
      .onConflictDoNothing()
      .returning()

    // Se for a tag especial "pessoa", aplica a pausa e notifica ponte externa
    if (normTag === 'pessoa') {
      const now = new Date()
      await db
        .update(recoveryLeads)
        .set({
          botPaused: true,
          botPausedAt: now,
          botPausedBy: `Atendente humano (${operatorName}) - tag pessoa`,
          botPausedAll: false,
          botPausedChannel: null,
          updatedAt: now,
        })
        .where(eq(recoveryLeads.id, lead.id))

      // Notifica ponte externa da Nina / AutonomIA
      await notifyNaoResponder({
        phone: lead.phone,
        action: 'pause',
        reason: `Tag pessoa adicionada por ${operatorName}`,
        channel: lead.channel || 'whatsapp',
      })
    }

    return NextResponse.json({
      ok: true,
      tag: createdTag || { tag: normTag, scopeChannel: finalScope },
    })
  } catch (err) {
    console.error('[API /leads/[leadId]/tags POST] Erro:', err)
    return NextResponse.json({ error: 'Erro ao adicionar tag' }, { status: 500 })
  }
}
