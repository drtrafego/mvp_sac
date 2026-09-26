import { NextRequest, NextResponse } from 'next/server'
import { requireCompany, getCurrentUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoveryLeads, leadTags } from '@/lib/db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { normalizeTag } from '@/lib/lead-tags'
import { notifyNaoResponder } from '@/lib/nao-responder'

type Params = { params: Promise<{ leadId: string; tag: string }> }

/**
 * DELETE /api/leads/[leadId]/tags/[tag]
 * Remove uma tag de um lead específico.
 * Se a tag removida for "pessoa", reativa o bot de IA (se a pausa era motivada pela tag pessoa)
 * e notifica a ponte externa para despausar.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const company = await requireCompany()
    const user = await getCurrentUser()
    const { leadId, tag } = await params

    const id = parseInt(leadId, 10)
    if (isNaN(id)) {
      return NextResponse.json({ error: 'ID de lead inválido' }, { status: 400 })
    }

    const normTag = normalizeTag(decodeURIComponent(tag))
    if (!normTag) {
      return NextResponse.json({ error: 'Nome da tag é obrigatório' }, { status: 400 })
    }

    const [lead] = await db
      .select()
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

    if (!lead) {
      return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })
    }

    const deleted = await db
      .delete(leadTags)
      .where(and(eq(leadTags.leadId, id), eq(leadTags.tag, normTag)))
      .returning()

    if (deleted.length === 0) {
      return NextResponse.json({ error: 'Tag não encontrada para este lead' }, { status: 404 })
    }

    // Se a tag removida era "pessoa", despausa o bot (se a pausa atual foi causada por pessoa)
    if (normTag === 'pessoa') {
      const operatorName = user?.displayName || user?.primaryEmail || 'Atendente humano'
      const isPausedByPessoa = (lead.botPausedBy || '').toLowerCase().includes('pessoa')

      if (isPausedByPessoa && lead.botPaused) {
        const now = new Date()
        await db
          .update(recoveryLeads)
          .set({
            botPaused: false,
            botPausedAt: null,
            botPausedBy: null,
            botPausedAll: false,
            botPausedChannel: null,
            updatedAt: now,
          })
          .where(eq(recoveryLeads.id, lead.id))

        await notifyNaoResponder({
          phone: lead.phone,
          action: 'unpause',
          reason: `Tag pessoa removida por ${operatorName}`,
          channel: lead.channel || 'whatsapp',
        })
      }
    }

    return NextResponse.json({ ok: true, removed: normTag })
  } catch (err) {
    console.error('[API /leads/[leadId]/tags/[tag] DELETE] Erro:', err)
    return NextResponse.json({ error: 'Erro ao remover tag' }, { status: 500 })
  }
}
