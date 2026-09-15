import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sequenceMessages, recoverySequences } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompany, AuthError, unauthorizedResponse } from '@/lib/auth'

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ type: string; id: string }> }
): Promise<NextResponse> {
  let company
  try {
    company = await requireCompany()
  } catch (err) {
    if (err instanceof AuthError) return unauthorizedResponse()
    throw err
  }

  const { id } = await params
  const body = await req.json()
  const msgId = parseInt(id)

  const [row] = await db
    .select({ message: sequenceMessages })
    .from(sequenceMessages)
    .innerJoin(recoverySequences, eq(sequenceMessages.sequenceId, recoverySequences.id))
    .where(and(eq(sequenceMessages.id, msgId), eq(recoverySequences.companyId, company.id)))

  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const existing = row.message

  const [updated] = await db
    .update(sequenceMessages)
    .set({
      content: body.content !== undefined ? body.content : existing.content,
      mediaUrl: body.mediaUrl !== undefined ? body.mediaUrl : existing.mediaUrl,
      caption: body.caption !== undefined ? body.caption : existing.caption,
      delayMinutes: body.delayMinutes !== undefined ? body.delayMinutes : existing.delayMinutes,
      messageType: body.messageType !== undefined ? body.messageType : existing.messageType,
      buttonsJson: body.buttonsJson !== undefined ? body.buttonsJson : existing.buttonsJson,
      templateName: body.templateName !== undefined ? body.templateName : existing.templateName,
      templateLanguage: body.templateLanguage !== undefined ? body.templateLanguage : existing.templateLanguage,
      templateVariablesMap: body.templateVariablesMap !== undefined ? body.templateVariablesMap : existing.templateVariablesMap,
      isActive: body.isActive !== undefined ? body.isActive : existing.isActive,
      order: body.order !== undefined ? body.order : existing.order,
    })
    .where(eq(sequenceMessages.id, msgId))
    .returning()

  return NextResponse.json(updated)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ type: string; id: string }> }
): Promise<NextResponse> {
  let company
  try {
    company = await requireCompany()
  } catch (err) {
    if (err instanceof AuthError) return unauthorizedResponse()
    throw err
  }

  const { id } = await params
  const msgId = parseInt(id)

  const [row] = await db
    .select({ id: sequenceMessages.id })
    .from(sequenceMessages)
    .innerJoin(recoverySequences, eq(sequenceMessages.sequenceId, recoverySequences.id))
    .where(and(eq(sequenceMessages.id, msgId), eq(recoverySequences.companyId, company.id)))

  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await db.delete(sequenceMessages).where(eq(sequenceMessages.id, msgId))
  return NextResponse.json({ ok: true })
}
