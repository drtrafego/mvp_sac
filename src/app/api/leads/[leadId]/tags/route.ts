export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { leadTags, recoveryLeads } from '@/lib/db/schema'
import { and, desc, eq } from 'drizzle-orm'
import { requireCompany, getCurrentUser } from '@/lib/auth'
import { normalizeTag, PESSOA_TAG, BOT_PAUSED_BY_TAG_PESSOA, MAX_TAG_LENGTH } from '@/lib/lead-tags'
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
 * Body: { tag: string }
 *
 * Adiciona uma tag ao lead (idempotente: já existir a mesma tag não é erro).
 * A tag especial "pessoa" (normalizada, ver normalizeTag()) além de etiquetar
 * pausa o bot de IA (botPaused=true, botPausedBy='tag:pessoa') e avisa a
 * ponte da Nina pra ela também não responder o contato fora do SAC. Essa
 * segunda parte NUNCA bloqueia a primeira: se a chamada à rota da Luana
 * falhar (rede, timeout, endpoint ainda não publicado), a tag e a pausa no
 * SAC já valem por si (cobrem 100% do fluxo síncrono via SAC), e a resposta
 * carrega um `warning` avisando que o resto não foi confirmado.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const company = await requireCompany()
  const user = await getCurrentUser()

  let body: { tag?: string } = {}
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

  const createdBy = user?.displayName || user?.primaryEmail?.split('@')[0] || 'humano'

  const [inserted] = await db
    .insert(leadTags)
    .values({ leadId: id, tag, createdBy })
    .onConflictDoNothing({ target: [leadTags.leadId, leadTags.tag] })
    .returning()

  let warning: string | undefined

  if (tag === PESSOA_TAG) {
    // Sempre reafirma a pausa, mesmo se a tag já existia (onConflictDoNothing
    // não insere de novo, mas o efeito colateral tem que valer sempre que
    // alguém chamar este endpoint com "pessoa" — idempotência da AÇÃO, não
    // só da linha).
    await db
      .update(recoveryLeads)
      .set({
        botPaused: true,
        botPausedAt: new Date(),
        botPausedBy: BOT_PAUSED_BY_TAG_PESSOA,
        updatedAt: new Date(),
      })
      .where(eq(recoveryLeads.id, id))

    const result = await notifyNaoResponder(lead.phone, 'marcar')
    if (!result.ok) warning = result.warning
  }

  const tags = await db
    .select()
    .from(leadTags)
    .where(eq(leadTags.leadId, id))
    .orderBy(desc(leadTags.createdAt))

  return NextResponse.json({ ok: true, tag: inserted ?? { leadId: id, tag, createdBy }, tags, warning })
}
