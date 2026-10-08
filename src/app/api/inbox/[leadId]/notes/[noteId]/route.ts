export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sacInternalNotes, sacAuditEvents } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireSacActor, ForbiddenError, AuthError } from '@/lib/auth'
import { roleSatisfies } from '@/lib/company-role'

function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

type Params = { params: Promise<{ leadId: string; noteId: string }> }

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { leadId, noteId } = await params
    const lId = parseInt(leadId)
    const nId = parseInt(noteId)
    if (isNaN(lId) || isNaN(nId)) return noStoreJson({ error: 'IDs inválidos' }, { status: 400 })

    const { company, actorId, actorName, role } = await requireSacActor()

    const [updated] = await db
      .update(sacInternalNotes)
      .set({
        deletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sacInternalNotes.id, nId),
          eq(sacInternalNotes.companyId, company.id),
          eq(sacInternalNotes.leadId, lId),
          roleSatisfies(role, 'admin') ? undefined : eq(sacInternalNotes.authorId, actorId)
        )
      )
      .returning()

    if (!updated) {
      return noStoreJson({ error: 'Nota interna não encontrada' }, { status: 404 })
    }

    await db.insert(sacAuditEvents).values({
      companyId: company.id, leadId: lId, type: 'internal_note_deleted',
      actorType: 'human', actorId, actorName,
      referenceType: 'sac_internal_notes', referenceId: String(nId),
    }).catch(() => { console.error('[SAC audit] internal_note_deleted not recorded', { companyId: company.id, leadId: lId }) })

    return noStoreJson({ success: true, deletedNoteId: nId })
  } catch (err: unknown) {
    if (err instanceof ForbiddenError || err instanceof AuthError) return noStoreJson({ error: err.message }, { status: err.status })
    return noStoreJson({ error: 'Erro ao excluir nota' }, { status: 500 })
  }
}
