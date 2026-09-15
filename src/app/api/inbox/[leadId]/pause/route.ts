export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompany, getCurrentUser } from '@/lib/auth'

type Params = { params: Promise<{ leadId: string }> }

/**
 * POST /api/inbox/[leadId]/pause
 * Pausa ou despausa o bot de IA para o atendimento/lead específico.
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const company = await requireCompany()
  const user = await getCurrentUser()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  let body: { paused?: boolean } = {}
  try {
    body = await req.json()
  } catch {
    // se não passar body, inverte o estado atual
  }

  const nextPaused = typeof body.paused === 'boolean' ? body.paused : !lead.botPaused
  const operatorName = user?.displayName || user?.primaryEmail?.split('@')[0] || 'humano'

  const [updated] = await db
    .update(recoveryLeads)
    .set({
      botPaused: nextPaused,
      botPausedAt: nextPaused ? new Date() : null,
      botPausedBy: nextPaused ? operatorName : null,
      updatedAt: new Date(),
    })
    .where(eq(recoveryLeads.id, id))
    .returning()

  return NextResponse.json({
    ok: true,
    leadId: updated.id,
    botPaused: updated.botPaused,
    botPausedAt: updated.botPausedAt,
    botPausedBy: updated.botPausedBy,
  })
}
