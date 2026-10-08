import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, recoverySequences, sequenceMessages, messageJobs } from '@/lib/db/schema'
import { eq, desc, and, gte, lte, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { getDateRange } from '@/lib/date-utils'
import { channelWhereCondition } from '@/lib/inbox-channel-filter'
import { parseIntegerQuery } from '@/lib/request-validation'

const LEADS_PAGE_SIZE_DEFAULT = 200
const LEADS_PAGE_SIZE_MAX = 200
const LEADS_OFFSET_MAX = 100_000

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
  const { searchParams } = new URL(req.url)
  const parsedLimit = parseIntegerQuery(searchParams.get('limit'), {
    defaultValue: LEADS_PAGE_SIZE_DEFAULT,
    min: 1,
    max: LEADS_PAGE_SIZE_MAX,
    label: 'limit',
  })
  if (!parsedLimit.ok) return NextResponse.json({ error: parsedLimit.error }, { status: 400 })

  const parsedOffset = parseIntegerQuery(searchParams.get('offset'), {
    defaultValue: 0,
    min: 0,
    max: LEADS_OFFSET_MAX,
    label: 'offset',
  })
  if (!parsedOffset.ok) return NextResponse.json({ error: parsedOffset.error }, { status: 400 })

  const company = await requireCompany()
  const eventType = searchParams.get('event_type')
  const status = searchParams.get('status')
  const product = searchParams.get('product')
  const source = searchParams.get('source')
  const platform = searchParams.get('platform')
  const paymentType = searchParams.get('payment_type')
  const tag = searchParams.get('tag')?.trim()
  const transactionId = searchParams.get('transaction_id')?.trim()
  const hasPhone = searchParams.get('has_phone')
  const hasEmail = searchParams.get('has_email')
  const hasTags = searchParams.get('has_tags')
  const isSale = searchParams.get('is_sale')
  const minValue = searchParams.get('min_value')
  const maxValue = searchParams.get('max_value')
  const search = searchParams.get('search')?.trim() || searchParams.get('q')?.trim()
  const limit = parsedLimit.value
  const offset = parsedOffset.value
  const period = searchParams.get('period') ?? '30d'
  const fromStr = searchParams.get('from') ?? undefined
  const toStr = searchParams.get('to') ?? undefined

  // Retorna lista de produtos distintos para o dropdown de filtro
  if (searchParams.get('products_only') === 'true') {
    const conditions = [eq(recoveryLeads.companyId, company.id)]
    if (eventType) conditions.push(eq(recoveryLeads.eventType, eventType))
    if (platform) conditions.push(eq(recoveryLeads.platform, platform))
    const rows = await db
      .selectDistinct({ productName: recoveryLeads.productName })
      .from(recoveryLeads)
      .where(and(...conditions, sql`${recoveryLeads.productName} is not null`))
      .orderBy(recoveryLeads.productName)
      .limit(200)
    return NextResponse.json(rows.map(r => r.productName).filter(Boolean))
  }

  // Retorna lista de plataformas distintas para o dropdown de filtro
  if (searchParams.get('platforms_only') === 'true') {
    const rows = await db
      .selectDistinct({ platform: recoveryLeads.platform })
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.companyId, company.id), sql`${recoveryLeads.platform} is not null`))
      .orderBy(recoveryLeads.platform)
      .limit(100)
    return NextResponse.json(rows.map(r => r.platform).filter(Boolean))
  }

  const { fromDate, toDate } = getDateRange(period, new Date(), fromStr, toStr)

  const conditions = [eq(recoveryLeads.companyId, company.id)]
  if (eventType) conditions.push(eq(recoveryLeads.eventType, eventType))
  if (status) {
    if (status === 'awaiting_contact') {
      conditions.push(sql`(${recoveryLeads.status} IN ('pending', 'new', 'aguardando') OR ${recoveryLeads.status} IS NULL)`)
    } else {
      conditions.push(eq(recoveryLeads.status, status))
    }
  }
  if (source) {
    const knownChannelCondition = channelWhereCondition(source)
    conditions.push(knownChannelCondition ?? sql`${recoveryLeads.trackingSource} ILIKE ${'%' + source + '%'}`)
  }
  if (platform) conditions.push(eq(recoveryLeads.platform, platform))
  if (product) conditions.push(eq(recoveryLeads.productName, product))
  if (paymentType) conditions.push(eq(recoveryLeads.paymentType, paymentType))

  // Busca textual global no banco (nome, telefone, email, produto, id da transação)
  if (search) {
    const pattern = `%${search}%`
    conditions.push(sql`(
      ${recoveryLeads.name} ILIKE ${pattern} OR
      ${recoveryLeads.phone} ILIKE ${pattern} OR
      ${recoveryLeads.email} ILIKE ${pattern} OR
      ${recoveryLeads.productName} ILIKE ${pattern} OR
      ${recoveryLeads.transactionId} ILIKE ${pattern}
    )`)
  }

  // Filtro por tags
  if (tag) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM lead_tags
      WHERE lead_tags.lead_id = ${recoveryLeads.id}
        AND lead_tags.tag ILIKE ${'%' + tag + '%'}
    )`)
  }

  // Filtro por existência de tags, telefone ou e-mail
  if (hasTags === 'true') {
    conditions.push(sql`EXISTS (SELECT 1 FROM lead_tags WHERE lead_tags.lead_id = ${recoveryLeads.id})`)
  }
  if (hasPhone === 'true') {
    conditions.push(sql`(${recoveryLeads.phone} IS NOT NULL AND ${recoveryLeads.phone} != '')`)
  }
  if (hasEmail === 'true') {
    conditions.push(sql`(${recoveryLeads.email} IS NOT NULL AND ${recoveryLeads.email} != '')`)
  }

  // Venda fechada versus Lead
  if (isSale === 'true') {
    conditions.push(eq(recoveryLeads.status, 'converted'))
  } else if (isSale === 'false') {
    conditions.push(sql`COALESCE(${recoveryLeads.status}, '') != 'converted'`)
  }

  // ID Externo / Transação
  if (transactionId) {
    conditions.push(sql`${recoveryLeads.transactionId} ILIKE ${'%' + transactionId + '%'}`)
  }

  // Valores Mínimo e Máximo
  if (minValue) {
    const minCents = parseValueToCents(minValue)
    if (minCents > 0) conditions.push(gte(recoveryLeads.productValue, minCents))
  }
  if (maxValue) {
    const maxCents = parseValueToCents(maxValue)
    if (maxCents > 0) conditions.push(lte(recoveryLeads.productValue, maxCents))
  }

  // Se houver busca por texto, permitimos buscar sem limitar estritamente pela data se fromStr não for explícito
  if (!search) {
    if (fromDate) conditions.push(gte(recoveryLeads.createdAt, fromDate))
    conditions.push(lte(recoveryLeads.createdAt, toDate))
  } else if (fromStr && fromDate) {
    conditions.push(gte(recoveryLeads.createdAt, fromDate))
    conditions.push(lte(recoveryLeads.createdAt, toDate))
  }

  // Exportação CSV completa no servidor para todos os leads filtrados da empresa
  if (searchParams.get('export') === 'csv') {
    const exportRows = await db
      .select()
      .from(recoveryLeads)
      .where(and(...conditions))
      .orderBy(desc(recoveryLeads.createdAt))
      .limit(10_000)

    const headers = ['ID', 'Nome', 'Telefone', 'Email', 'Produto', 'Valor (R$)', 'Evento', 'Status', 'Plataforma', 'Origem', 'ID Transacao', 'Data de Criacao']
    const escapeCsv = (val: unknown) => {
      if (val == null) return '""'
      const str = String(val).replace(/"/g, '""')
      return `"${str}"`
    }

    const csvLines = [
      headers.join(';'),
      ...exportRows.map(l => [
        escapeCsv(l.id),
        escapeCsv(l.name),
        escapeCsv(l.phone),
        escapeCsv(l.email),
        escapeCsv(l.productName),
        escapeCsv(l.productValue ? (l.productValue / 100).toFixed(2).replace('.', ',') : '0,00'),
        escapeCsv(l.eventType),
        escapeCsv(l.status),
        escapeCsv(l.platform),
        escapeCsv(l.channel || l.trackingSource),
        escapeCsv(l.transactionId),
        escapeCsv(l.createdAt ? new Date(l.createdAt).toISOString() : ''),
      ].join(';'))
    ]

    // UTF-8 BOM (\uFEFF) para compatibilidade nativa com Excel
    const csvContent = '\uFEFF' + csvLines.join('\r\n')
    const filename = `leads_export_${new Date().toISOString().split('T')[0]}.csv`

    return new NextResponse(csvContent, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  let query = db
    .select()
    .from(recoveryLeads)
    .where(and(...conditions))
    .orderBy(desc(recoveryLeads.createdAt))

  // @ts-expect-error Drizzle preserva o tipo sem limit(), mas a query continua compatível em runtime.
  query = query.limit(limit)
  if (offset > 0) {
    // @ts-expect-error Drizzle preserva o tipo sem offset(), mas a query continua compatível em runtime.
    query = query.offset(offset)
  }

  const leads = await query

  return NextResponse.json(leads)
}

/**
 * POST - Cadastro Manual de Lead (1x1)
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const parsedBody: unknown = await req.json().catch(() => null)
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: 'O corpo da requisição deve ser um objeto JSON.' }, { status: 400 })
  }
  const body = parsedBody as Record<string, unknown>

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

  const optionalTextFields = [
    ['name', name],
    ['email', email],
    ['productName', productName],
    ['eventType', eventType],
    ['trackingSource', trackingSource],
    ['utmMedium', utmMedium],
    ['paymentType', paymentType],
  ] as const
  const invalidTextField = optionalTextFields.find(([, value]) => value != null && typeof value !== 'string')
  if (invalidTextField) {
    return NextResponse.json({ error: `O campo ${invalidTextField[0]} deve ser um texto.` }, { status: 400 })
  }
  if (productValue != null && typeof productValue !== 'string' && typeof productValue !== 'number') {
    return NextResponse.json({ error: 'O campo productValue deve ser um texto ou número.' }, { status: 400 })
  }

  const cleanName = typeof name === 'string' ? name.trim() : ''
  const cleanEmail = typeof email === 'string' ? email.trim() : ''
  const cleanProductName = typeof productName === 'string' ? productName.trim() : ''
  const cleanEventType = typeof eventType === 'string' ? eventType : 'carrinho_abandonado'
  const cleanTrackingSource = typeof trackingSource === 'string' ? trackingSource : 'mineracao'
  const cleanUtmMedium = typeof utmMedium === 'string' ? utmMedium : 'whatsapp'
  const cleanPaymentType = typeof paymentType === 'string' ? paymentType : 'pix'

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
        name: cleanName || existing.name,
        email: cleanEmail || existing.email,
        productName: cleanProductName || existing.productName,
        productValue: cents > 0 ? cents : existing.productValue,
        eventType: cleanEventType || existing.eventType,
        trackingSource: cleanTrackingSource || existing.trackingSource,
        utmMedium: cleanUtmMedium || existing.utmMedium,
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
        name: cleanName || null,
        email: cleanEmail || null,
        productName: cleanProductName || 'Produto Principal',
        productValue: cents,
        eventType: cleanEventType,
        trackingSource: cleanTrackingSource,
        utmMedium: cleanUtmMedium,
        paymentType: cleanPaymentType,
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
      .where(and(eq(recoverySequences.companyId, company.id), eq(recoverySequences.eventType, cleanEventType)))
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
