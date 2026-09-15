import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoverySequences, sequenceMessages } from '@/lib/db/schema'
import { eq, and, asc } from 'drizzle-orm'
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

  if (!sequence) return NextResponse.json({ sequence: null, messages: [] })

  const messages = await db
    .select()
    .from(sequenceMessages)
    .where(eq(sequenceMessages.sequenceId, sequence.id))
    .orderBy(asc(sequenceMessages.order))

  return NextResponse.json({ sequence, messages })
}

export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { type } = await params
  if (!VALID_EVENT_TYPES.includes(type)) {
    return NextResponse.json({ error: 'Tipo de evento inválido' }, { status: 400 })
  }
  const company = await requireCompany()
  const body = await req.json()

  const [existing] = await db
    .select()
    .from(recoverySequences)
    .where(and(eq(recoverySequences.companyId, company.id), eq(recoverySequences.eventType, type)))

  if (existing) {
    const [updated] = await db
      .update(recoverySequences)
      .set({
        isActive: body.isActive !== undefined ? body.isActive : existing.isActive,
        name: body.name !== undefined ? body.name : existing.name,
        productFilter: body.productFilter !== undefined ? body.productFilter : existing.productFilter,
        upsellMessage: body.upsellMessage !== undefined ? body.upsellMessage : existing.upsellMessage,
        upsellDelayMinutes: body.upsellDelayMinutes !== undefined ? body.upsellDelayMinutes : existing.upsellDelayMinutes,
        updatedAt: new Date(),
      })
      .where(eq(recoverySequences.id, existing.id))
      .returning()
    return NextResponse.json(updated)
  }

  const [created] = await db
    .insert(recoverySequences)
    .values({
      companyId: company.id,
      eventType: type,
      isActive: body.isActive ?? false,
      name: body.name ?? type,
      productFilter: body.productFilter ?? null,
      upsellMessage: body.upsellMessage ?? null,
      upsellDelayMinutes: body.upsellDelayMinutes ?? 1440,
    })
    .returning()
  return NextResponse.json(created)
}
