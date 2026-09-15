export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { whatsappMessages, recoveryLeads } from '@/lib/db/schema'
import { eq, asc, and } from 'drizzle-orm'
import { sendWhatsAppMessage } from '@/lib/whatsapp'
import { requireCompany } from '@/lib/auth'

type Params = { params: Promise<{ leadId: string }> }

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const messages = await db
    .select()
    .from(whatsappMessages)
    .where(and(eq(whatsappMessages.phone, lead.phone), eq(whatsappMessages.companyId, company.id)))
    .orderBy(asc(whatsappMessages.createdAt))
    .limit(300)

  return NextResponse.json(messages)
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 })

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json() as { content: string; messageType?: string; mediaUrl?: string }

  if (!body.content?.trim() && !body.mediaUrl) {
    return NextResponse.json({ error: 'Mensagem vazia' }, { status: 400 })
  }

  await sendWhatsAppMessage(lead.phone, {
    type: (body.messageType ?? 'text') as 'text' | 'image' | 'video' | 'audio' | 'document',
    content: body.content,
    mediaUrl: body.mediaUrl,
  }, company.id)

  const [msg] = await db.insert(whatsappMessages).values({
    companyId: company.id,
    leadId: lead.id,
    phone: lead.phone,
    direction: 'outbound',
    content: body.content ?? null,
    messageType: body.messageType ?? 'text',
    mediaUrl: body.mediaUrl ?? null,
    sentBy: 'human',
  }).returning()

  return NextResponse.json(msg)
}
