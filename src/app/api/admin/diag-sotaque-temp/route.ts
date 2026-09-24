import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { eq, asc } from 'drizzle-orm'

const OPS_KEY = process.env.OPS_DIAG_SOTAQUE_KEY?.trim()

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const key = searchParams.get('key')
  const phone = searchParams.get('phone')

  if (!OPS_KEY) {
    return NextResponse.json({ error: 'OPS_DIAG_SOTAQUE_KEY não configurada' }, { status: 503 })
  }
  if (!key || !safeEqual(key, OPS_KEY)) {
    return NextResponse.json({ error: 'chave inválida' }, { status: 401 })
  }
  if (!phone) {
    return NextResponse.json({ error: 'phone obrigatório' }, { status: 400 })
  }

  const [lead] = await db.select().from(recoveryLeads).where(eq(recoveryLeads.phone, phone)).limit(1)
  if (!lead) {
    return NextResponse.json({ error: 'lead não encontrado', phone }, { status: 404 })
  }

  const msgs = await db
    .select({
      id: whatsappMessages.id,
      direction: whatsappMessages.direction,
      content: whatsappMessages.content,
      sentBy: whatsappMessages.sentBy,
      senderName: whatsappMessages.senderName,
      createdAt: whatsappMessages.createdAt,
    })
    .from(whatsappMessages)
    .where(eq(whatsappMessages.leadId, lead.id))
    .orderBy(asc(whatsappMessages.createdAt))

  return NextResponse.json({
    lead: {
      id: lead.id,
      companyId: lead.companyId,
      name: lead.name,
      phone: lead.phone,
      trackingSource: lead.trackingSource,
      pipelineStage: lead.pipelineStage,
    },
    messageCount: msgs.length,
    messages: msgs,
  })
}
