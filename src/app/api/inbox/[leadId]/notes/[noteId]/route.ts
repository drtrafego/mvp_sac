export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sacInternalNotes } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'

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

    const company = await requireCompany()

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
          eq(sacInternalNotes.leadId, lId)
        )
      )
      .returning()

    if (!updated) {
      return noStoreJson({ error: 'Nota interna não encontrada' }, { status: 404 })
    }

    return noStoreJson({ success: true, deletedNoteId: nId })
  } catch (err: any) {
    return noStoreJson({ error: err.message || 'Erro ao excluir nota' }, { status: 500 })
  }
}
