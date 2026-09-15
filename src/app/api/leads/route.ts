import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, recoverySequences, sequenceMessages, messageJobs } from '@/lib/db/schema'
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { getDateRange } from '@/lib/date-utils'

function cleanPhone(raw: string): string {
  let digits = raw.replace(/\D/g, '')
  if (digits.startsWith('0')) digits = digits.slice(1)
  if (digits.length === 10 || digits.length === 11) {
    digits = '55' + digits
  }
  return digits
}

function parseValueToCents(raw: string | number | null | undefined): number {
  if (raw == null) return 0
  if (typeof raw === 'number') return Math.round(raw * 100)
  const cleaned = String(raw).replace(/[^0-9,-.]/g, '').trim()
  if (!cleaned) return 0
  if (cleaned.includes(',')) {
    const norm = cleaned.replace(/\./g, '').replace(',', '.')
    return Math.round(parseFloat(norm) * 100) || 0
  }
  return Math.round(parseFloat(cleaned) * 100) || 0
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const { searchParams } = new URL(req.url)
  const eventType = searchParams.get('event_type')
  const status = searchParams.get('status')
  const product = searchParams.get('product')
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50'), 500)
  const offset = parseInt(searchParams.get('offset') ?? '0')
  const period = searchParams.get('period') ?? '30d'
  const fromStr = searchParams.get('from') ?? undefined
  const toStr = searchParams.get('to') ?? undefined

  // Retorna lista de produtos distintos para o dropdown de filtro
  if (searchParams.get('products_only') === 'true') {
    const conditions = [eq(recoveryLeads.companyId, company.id)]
    if (eventType) conditions.push(eq(recoveryLeads.eventType, eventType))
    const rows = await db
      .selectDistinct({ productName: recoveryLeads.productName })
      .from(recoveryLeads)
      .where(and(...conditions, sql`${recoveryLeads.productName} is not null`))
      .orderBy(recoveryLeads.productName)
      .limit(50)
    return NextResponse.json(rows.map(r => r.productName).filter(Boolean))
  }

  const { fromDate, toDate } = getDateRange(period, new Date(), fromStr, toStr)

  const conditions = [eq(recoveryLeads.companyId, company.id)]
  if (eventType) conditions.push(eq(recoveryLeads.eventType, eventType))
  if (status) conditions.push(eq(recoveryLeads.status, status))
  if (product) conditions.push(eq(recoveryLeads.productName, product))
  if (fromDate) conditions.push(gte(recoveryLeads.createdAt, fromDate))
  conditions.push(lte(recoveryLeads.createdAt, toDate))

  const leads = await db
    .select()
    .from(recoveryLeads)
    .where(and(...conditions))
    .orderBy(desc(recoveryLeads.createdAt))
    .limit(limit)
    .offset(offset)

  return NextResponse.json(leads)
}

/**
 * POST - Cadastro Manual de Lead (1x1)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const body = await req.json()

  const {
    name,
    phone: rawPhone,
    email,
    productName = 'Produto Principal',
    productValue,
    eventType = 'carrinho_abandonado',
    trackingSource = 'mineracao',
    utmMedium = 'whatsapp',
    paymentType = 'pix',
    triggerSequence = false,
  } = body

  if (!rawPhone || typeof rawPhone !== 'string') {
    return NextResponse.json({ error: 'O número de telefone/WhatsApp é obrigatório.' }, { status: 400 })
  }

  const phone = cleanPhone(rawPhone)
  if (phone.length < 10) {
    return NextResponse.json({ error: 'Número de telefone inválido (mínimo 10 dígitos com DDD).' }, { status: 400 })
  }

  const cents = typeof productValue === 'number' && Number.isInteger(productValue) && productValue > 1000
    ? productValue
    : parseValueToCents(productValue)

  // Verifica se o lead já existe para a empresa
  const [existing] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.companyId, company.id), eq(recoveryLeads.phone, phone)))
    .limit(1)

  let leadRecord: typeof recoveryLeads.$inferSelect

  if (existing) {
    const [updated] = await db
      .update(recoveryLeads)
      .set({
        name: name?.trim() || existing.name,
        email: email?.trim() || existing.email,
        productName: productName?.trim() || existing.productName,
        productValue: cents > 0 ? cents : existing.productValue,
        eventType: eventType || existing.eventType,
        trackingSource: trackingSource || existing.trackingSource,
        utmMedium: utmMedium || existing.utmMedium,
        updatedAt: new Date(),
      })
      .where(eq(recoveryLeads.id, existing.id))
      .returning()
    leadRecord = updated
  } else {
    const [created] = await db
      .insert(recoveryLeads)
      .values({
        companyId: company.id,
        phone,
        name: name?.trim() || null,
        email: email?.trim() || null,
        productName: productName?.trim() || 'Produto Principal',
        productValue: cents,
        eventType,
        trackingSource,
        utmMedium,
        paymentType,
        status: 'pending',
      })
      .returning()
    leadRecord = created
  }

  // Se solicitado disparar a sequência de recuperação/outreach
  if (triggerSequence && leadRecord) {
    const [seq] = await db
      .select()
      .from(recoverySequences)
      .where(and(eq(recoverySequences.companyId, company.id), eq(recoverySequences.eventType, eventType)))
      .limit(1)

    if (seq && seq.isActive) {
      const messages = await db
        .select()
        .from(sequenceMessages)
        .where(and(eq(sequenceMessages.sequenceId, seq.id), eq(sequenceMessages.isActive, true)))
        .orderBy(sequenceMessages.order)

      for (const msg of messages) {
        const scheduledFor = new Date(Date.now() + (msg.delayMinutes || 0) * 60 * 1000)
        await db.insert(messageJobs).values({
          leadId: leadRecord.id,
          messageId: msg.id,
          messageOrder: msg.order,
          scheduledFor,
          status: 'pending',
          checkBeforeSend: true,
        })
      }
    }
  }

  return NextResponse.json({ success: true, lead: leadRecord })
}
