import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoverySequences, sequenceMessages } from '@/lib/db/schema'
import { eq, and, asc, max } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'

const VALID_EVENT_TYPES = ['carrinho_abandonado', 'cartao_recusado', 'boleto', 'pix', 'compra_aprovada', 'disputa']

type Params = { params: Promise<{ type: string }> }

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { type } = await params
  if (!VALID_EVENT_TYPES.includes(type)) {
    return NextResponse.json({ error: 'Tipo de evento inválido' }, { status: 400 })
  }
  const company = await requireCompany()

  const [sequence] = await db
    .select()
    .from(recoverySequences)
    .where(and(eq(recoverySequences.companyId, company.id), eq(recoverySequences.eventType, type)))

  if (!sequence) return NextResponse.json([])

  const messages = await db
    .select()
    .from(sequenceMessages)
    .where(eq(sequenceMessages.sequenceId, sequence.id))
    .orderBy(asc(sequenceMessages.order))

  return NextResponse.json(messages)
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { type } = await params
  if (!VALID_EVENT_TYPES.includes(type)) {
    return NextResponse.json({ error: 'Tipo de evento inválido' }, { status: 400 })
  }
  const company = await requireCompany()
  const body = await req.json()

  let [sequence] = await db
    .select()
    .from(recoverySequences)
    .where(and(eq(recoverySequences.companyId, company.id), eq(recoverySequences.eventType, type)))

  if (!sequence) {
    const [created] = await db
      .insert(recoverySequences)
      .values({ companyId: company.id, eventType: type, name: type, isActive: false, updatedAt: new Date() })
      .returning()
    sequence = created
  }

  const [maxResult] = await db
    .select({ maxOrder: max(sequenceMessages.order) })
    .from(sequenceMessages)
    .where(eq(sequenceMessages.sequenceId, sequence.id))

  const nextOrder = (maxResult?.maxOrder ?? 0) + 1

  const [message] = await db
    .insert(sequenceMessages)
    .values({
      sequenceId: sequence.id,
      order: nextOrder,
      delayMinutes: body.delayMinutes ?? 0,
      messageType: body.messageType ?? 'text',
      content: body.content ?? null,
      mediaUrl: body.mediaUrl ?? null,
      caption: body.caption ?? null,
      buttonsJson: body.buttonsJson ?? null,
      templateName: body.templateName ?? null,
      templateLanguage: body.templateLanguage ?? null,
      templateVariablesMap: body.templateVariablesMap ?? null,
      isActive: body.isActive ?? true,
    })
    .returning()

  return NextResponse.json(message, { status: 201 })
}
