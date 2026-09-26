export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { leadTags, recoveryLeads } from '@/lib/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { normalizeTag, PESSOA_TAG, BOT_PAUSED_BY_TAG_PESSOA } from '@/lib/lead-tags'
import { notifyNaoResponder } from '@/lib/nao-responder'

type Params = { params: Promise<{ leadId: string; tag: string }> }

/**
 * DELETE /api/leads/[leadId]/tags/[tag]
 * Remove uma tag do lead. Se a tag removida for "pessoa": avisa a ponte da
 * Nina pra voltar a responder e reverte botPaused=false quando a pausa era motivada pela tag pessoa.
 */
export async function DELETE(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { leadId, tag: rawTagParam } = await params
    const id = parseInt(leadId, 10)
    if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

    const tag = normalizeTag(decodeURIComponent(rawTagParam))
    if (!tag) return NextResponse.json({ error: 'Tag inválida' }, { status: 400 })

    const company = await requireCompany()

    const [lead] = await db
      .select()
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

    if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

    const [deleted] = await db
      .delete(leadTags)
      .where(and(eq(leadTags.leadId, id), eq(leadTags.tag, tag)))
      .returning()

    if (!deleted) return NextResponse.json({ error: 'Tag não encontrada neste lead' }, { status: 404 })

    let warning: string | undefined
    let botPaused = lead.botPaused

    if (tag === PESSOA_TAG) {
      const capturedBotPausedAt = lead.botPausedAt

      const result = await notifyNaoResponder({
        phone: lead.phone,
        action: 'unpause',
        reason: 'Tag pessoa removida',
        channel: lead.channel || 'whatsapp',
      })
      if (!result.ok) warning = result.warning

      const isPausedByPessoa = (lead.botPausedBy || '').toLowerCase().includes('pessoa')

      if (isPausedByPessoa && lead.botPaused) {
        const [updated] = await db
          .update(recoveryLeads)
          .set({
            botPaused: false,
            botPausedAt: null,
            botPausedBy: null,
            botPausedAll: false,
            botPausedChannel: null,
            updatedAt: new Date(),
          })
          .where(and(
            eq(recoveryLeads.id, id),
            capturedBotPausedAt === null
              ? isNull(recoveryLeads.botPausedAt)
              : eq(recoveryLeads.botPausedAt, capturedBotPausedAt),
          ))
          .returning()

        if (updated) {
          botPaused = updated.botPaused
        } else {
          const [fresh] = await db.select().from(recoveryLeads).where(eq(recoveryLeads.id, id))
          botPaused = fresh?.botPaused ?? lead.botPaused
        }
      }
    }

    const tags = await db.select().from(leadTags).where(eq(leadTags.leadId, id))

    return NextResponse.json({ ok: true, removed: tag, tags, botPaused, warning })
  } catch (err) {
    console.error('[API /leads/[leadId]/tags/[tag] DELETE] Erro:', err)
    return NextResponse.json({ error: 'Erro ao remover tag' }, { status: 500 })
  }
}
