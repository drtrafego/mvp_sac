import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoverySequences, sequenceMessages } from '@/lib/db/schema'
import { eq, and, max } from 'drizzle-orm'
import { requireCompany, AuthError, unauthorizedResponse } from '@/lib/auth'
import { BIBLIOTECA } from '@/lib/biblioteca'

export async function GET(): Promise<NextResponse> {
  try {
    await requireCompany()
  } catch (err) {
    if (err instanceof AuthError) return unauthorizedResponse()
    throw err
  }
  return NextResponse.json(BIBLIOTECA)
}

// POST /api/biblioteca { presetId: string } — importa sequência para a empresa
export async function POST(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const { presetId } = await req.json()

  const preset = BIBLIOTECA.find(p => p.id === presetId)
  if (!preset) return NextResponse.json({ error: 'Preset não encontrado' }, { status: 404 })

  let [sequence] = await db
    .select()
    .from(recoverySequences)
    .where(and(eq(recoverySequences.companyId, company.id), eq(recoverySequences.eventType, preset.eventType)))

  if (!sequence) {
    const [created] = await db
      .insert(recoverySequences)
      .values({
        companyId: company.id,
        eventType: preset.eventType,
        name: preset.name,
        isActive: false,
        updatedAt: new Date(),
      })
      .returning()
    sequence = created
  }

  const [maxResult] = await db
    .select({ maxOrder: max(sequenceMessages.order) })
    .from(sequenceMessages)
    .where(eq(sequenceMessages.sequenceId, sequence.id))

  const baseOrder = maxResult?.maxOrder ?? 0

  await db.insert(sequenceMessages).values(
    preset.messages.map(msg => ({
      sequenceId: sequence.id,
      order: baseOrder + msg.order,
      delayMinutes: msg.delayMinutes,
      messageType: msg.messageType,
      content: msg.content,
      isActive: true,
    }))
  )

  return NextResponse.json({ ok: true, sequenceId: sequence.id, messagesAdded: preset.messages.length })
}
