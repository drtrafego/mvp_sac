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
 * Lista as tags do lead, mais recente primeiro.
 */
export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

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
}

/**
 * POST /api/leads/[leadId]/tags
 * Body: { tag: string, scopeChannel?: string | null }
 *
 * Adiciona uma tag ao lead (idempotente: já existir a mesma tag no mesmo escopo não é erro).
 * A tag especial "pessoa" (normalizada, ver normalizeTag()) além de etiquetar
 * pausa o bot de IA (botPaused=true, botPausedBy='tag:pessoa') e avisa a
 * ponte da Nina pra ela também não responder o contato fora do SAC.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const company = await requireCompany()
  const user = await getCurrentUser()

  let body: { tag?: string; scopeChannel?: string | null } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body inválido' }, { status: 400 })
  }

  const rawTag = typeof body.tag === 'string' ? body.tag : ''
  const tag = normalizeTag(rawTag)
  if (!tag) {
    return NextResponse.json({ error: `Tag inválida (vazia ou só espaço, máx. ${MAX_TAG_LENGTH} caracteres)` }, { status: 400 })
  }

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  const scopeValidation = validateTagScope(tag, body.scopeChannel, lead.channel)
  if (!scopeValidation.ok) {
    return NextResponse.json({ error: scopeValidation.error }, { status: 400 })
  }

  const scopeChannel = scopeValidation.scopeChannel
  const createdBy = user?.displayName || user?.primaryEmail?.split('@')[0] || 'humano'

  const [inserted] = await db
    .insert(leadTags)
    .values({ leadId: id, tag, scopeChannel, createdBy })
    .onConflictDoNothing({ target: [leadTags.leadId, leadTags.tag, leadTags.scopeChannel] })
    .returning()

  let warning: string | undefined

  if (tag === PESSOA_TAG) {
    await db
      .update(recoveryLeads)
      .set({
        botPaused: true,
        botPausedAt: new Date(),
        botPausedBy: BOT_PAUSED_BY_TAG_PESSOA,
        updatedAt: new Date(),
      })
      .where(eq(recoveryLeads.id, id))

    const result = await notifyNaoResponder(lead.phone, 'marcar', lead.channel)
    if (!result.ok) warning = result.warning
  }

  const tags = await db
    .select()
    .from(leadTags)
    .where(eq(leadTags.leadId, id))
    .orderBy(desc(leadTags.createdAt))

  return NextResponse.json({ ok: true, tag: inserted ?? { leadId: id, tag, scopeChannel, createdBy }, tags, warning })
}
