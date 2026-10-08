export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, sacInternalNotes, sacAuditEvents } from '@/lib/db/schema'
import { eq, and, isNull, desc } from 'drizzle-orm'
import { requireCompanyRole, requireSacActor, ForbiddenError, AuthError } from '@/lib/auth'
import { SacInputError } from '@/lib/sac-access'

function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

type Params = { params: Promise<{ leadId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { leadId } = await params
    const id = parseInt(leadId)
    if (isNaN(id)) return noStoreJson({ error: 'ID inválido' }, { status: 400 })

    const { company } = await requireCompanyRole('membro')

    // Validar lead pertencente à empresa
    const [lead] = await db
      .select({ id: recoveryLeads.id })
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

    if (!lead) return noStoreJson({ error: 'Lead não encontrado' }, { status: 404 })

    const notes = await db
      .select()
      .from(sacInternalNotes)
      .where(
        and(
          eq(sacInternalNotes.companyId, company.id),
          eq(sacInternalNotes.leadId, id),
          isNull(sacInternalNotes.deletedAt)
        )
      )
      .orderBy(desc(sacInternalNotes.createdAt))

    return noStoreJson({
      notes: notes.map((n) => ({
        id: n.id,
        body: n.body,
        authorType: n.authorType,
        authorId: n.authorId,
        authorName: n.authorName,
        createdAt: n.createdAt?.toISOString() ?? null,
        updatedAt: n.updatedAt?.toISOString() ?? null,
      })),
    })
  } catch (err: unknown) {
    if (err instanceof SacInputError || err instanceof ForbiddenError || err instanceof AuthError) return noStoreJson({ error: err.message }, { status: err.status })
    return noStoreJson({ error: 'Erro ao carregar notas' }, { status: 500 })
  }
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { leadId } = await params
    const id = parseInt(leadId)
    if (isNaN(id)) return noStoreJson({ error: 'ID inválido' }, { status: 400 })

    const { company, actorId: authorId, actorName: authorName } = await requireSacActor()

    const [lead] = await db
      .select()
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

    if (!lead) return noStoreJson({ error: 'Lead não encontrado' }, { status: 404 })

    const body = await req.json().catch(() => null)
    if (!body || typeof body.body !== 'string' || !body.body.trim()) {
      return noStoreJson({ error: 'O conteúdo da nota interna é obrigatório.' }, { status: 400 })
    }

    const noteText = body.body.trim()
    const [newNote] = await db
      .insert(sacInternalNotes)
      .values({
        companyId: company.id,
        leadId: id,
        authorType: 'human',
        authorId,
        authorName,
        body: noteText,
      })
      .returning()

    // Log de auditoria
    await db.insert(sacAuditEvents).values({
      companyId: company.id,
      leadId: id,
      type: 'internal_note_added',
      actorType: 'human',
      actorId: authorId,
      actorName: authorName,
      referenceType: 'sac_internal_notes',
      referenceId: String(newNote.id),
      payload: {
        noteId: newNote.id,
        preview: noteText.slice(0, 80),
      },
    }).catch(() => { console.error('[SAC audit] internal_note_added not recorded', { companyId: company.id, leadId: id }) })

    return noStoreJson({
      success: true,
      note: {
        id: newNote.id,
        body: newNote.body,
        authorType: newNote.authorType,
        authorId: newNote.authorId,
        authorName: newNote.authorName,
        createdAt: newNote.createdAt?.toISOString() ?? null,
        updatedAt: newNote.updatedAt?.toISOString() ?? null,
      },
    }, { status: 201 })
  } catch (err: unknown) {
    if (err instanceof SacInputError || err instanceof ForbiddenError || err instanceof AuthError) return noStoreJson({ error: err.message }, { status: err.status })
    return noStoreJson({ error: 'Erro ao criar nota interna' }, { status: 500 })
  }
}
