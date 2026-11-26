import { getInheritedPauseFields } from '@/lib/bot-pause'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { leadTags, recoveryLeads, recoverySequences, sacAuditEvents, sequenceMessages, messageJobs } from '@/lib/db/schema'
import { eq, desc, and, gte, lte, inArray, or, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { getDateRange } from '@/lib/date-utils'
import { channelWhereCondition } from '@/lib/inbox-channel-filter'
import { parseIntegerQuery } from '@/lib/request-validation'

const LEADS_PAGE_SIZE_DEFAULT = 200
const LEADS_PAGE_SIZE_MAX = 200
const LEADS_OFFSET_MAX = 100_000

function parseFilterList(raw: string | null): string[] {
  return [...new Set((raw ?? '').split(',').map(value => value.trim()).filter(Boolean))]
}

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
  const eventTypes = parseFilterList(searchParams.get('event_type'))
  const statuses = parseFilterList(searchParams.get('status'))
  const products = parseFilterList(searchParams.get('product'))
  const sources = parseFilterList(searchParams.get('source'))
  const platforms = parseFilterList(searchParams.get('platform'))
  const channels = parseFilterList(searchParams.get('channel'))
  const paymentType = searchParams.get('payment_type')
  const tags = parseFilterList(searchParams.get('tag'))
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

  if (searchParams.get('options_only') === 'true') {
    const [eventRows, statusRows, sourceRows, platformRows, channelRows, productRows, tagRows] = await Promise.all([
      db.selectDistinct({ value: recoveryLeads.eventType }).from(recoveryLeads).where(eq(recoveryLeads.companyId, company.id)),
      db.selectDistinct({ value: recoveryLeads.status }).from(recoveryLeads).where(eq(recoveryLeads.companyId, company.id)),
      db.selectDistinct({ value: recoveryLeads.trackingSource }).from(recoveryLeads).where(eq(recoveryLeads.companyId, company.id)),
      db.selectDistinct({ value: recoveryLeads.platform }).from(recoveryLeads).where(eq(recoveryLeads.companyId, company.id)),
      db.selectDistinct({ value: recoveryLeads.channel }).from(recoveryLeads).where(eq(recoveryLeads.companyId, company.id)),
      db.selectDistinct({ value: recoveryLeads.productName }).from(recoveryLeads).where(eq(recoveryLeads.companyId, company.id)),
      db.selectDistinct({ value: leadTags.tag }).from(leadTags).innerJoin(recoveryLeads, eq(recoveryLeads.id, leadTags.leadId)).where(eq(recoveryLeads.companyId, company.id)),
    ])
    const values = (rows: Array<{ value: string | null }>) => [...new Set(rows.map(row => row.value).filter((value): value is string => Boolean(value?.trim())).map(value => value.trim()))].sort((a, b) => a.localeCompare(b, 'pt-BR'))
    const statusValues = values(statusRows)
    return NextResponse.json({
      eventTypes: values(eventRows),
      statuses: statusValues,
      sources: values(sourceRows),
      platforms: values(platformRows),
      channels: values(channelRows),
      products: values(productRows),
      tags: values(tagRows),
    })
  }

  // Retorna lista de produtos distintos para o dropdown de filtro
  if (searchParams.get('products_only') === 'true') {
    const conditions = [eq(recoveryLeads.companyId, company.id)]
    if (eventTypes.length) conditions.push(inArray(recoveryLeads.eventType, eventTypes))
    if (platforms.length) conditions.push(inArray(recoveryLeads.platform, platforms))
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
  if (eventTypes.length) conditions.push(inArray(recoveryLeads.eventType, eventTypes))
  if (statuses.length) {
    const statusConditions = statuses.map(status => {
      if (status === 'awaiting_contact') {
        return sql`(${recoveryLeads.status} IN ('pending', 'new', 'aguardando') OR ${recoveryLeads.status} IS NULL)`
      }
      return eq(recoveryLeads.status, status)
    })
    conditions.push(or(...statusConditions)!)
  }
  if (sources.length) {
    const sourceConditions = sources.map(source => channelWhereCondition(source) ?? sql`${recoveryLeads.trackingSource} ILIKE ${'%' + source + '%'}`)
    conditions.push(or(...sourceConditions)!)
  }
  if (platforms.length) conditions.push(inArray(recoveryLeads.platform, platforms))
  if (products.length) conditions.push(inArray(recoveryLeads.productName, products))
  if (channels.length) conditions.push(inArray(recoveryLeads.channel, channels))
  if (paymentType) conditions.push(eq(recoveryLeads.paymentType, paymentType))

  // Busca textual global no banco. Além dos dados de contato, inclui os campos
  // que identificam a origem do lead no SAC (produto, evento, plataforma,
  // origem, transação e tags). Sem isso, um lead do quiz continuava no banco e
  // aparecia pelo filtro/tag, mas a busca literal "quiz" devolvia zero.
  if (search) {
    const pattern = `%${search}%`
    conditions.push(sql`(
      ${recoveryLeads.name} ILIKE ${pattern} OR
      ${recoveryLeads.phone} ILIKE ${pattern} OR
      ${recoveryLeads.email} ILIKE ${pattern} OR
      ${recoveryLeads.productName} ILIKE ${pattern} OR
      ${recoveryLeads.eventType} ILIKE ${pattern} OR
      ${recoveryLeads.platform} ILIKE ${pattern} OR
      ${recoveryLeads.trackingSource} ILIKE ${pattern} OR
      ${recoveryLeads.transactionId} ILIKE ${pattern} OR
      ${recoveryLeads.notes} ILIKE ${pattern} OR
      EXISTS (
        SELECT 1 FROM lead_tags
        WHERE lead_tags.lead_id = ${recoveryLeads.id}
          AND lead_tags.tag ILIKE ${pattern}
      )
    )`)
  }

  // Filtro por tags
  if (tags.length) {
    conditions.push(or(...tags.map(tag => sql`EXISTS (
      SELECT 1 FROM lead_tags
      WHERE lead_tags.lead_id = ${recoveryLeads.id}
        AND lead_tags.tag ILIKE ${'%' + tag + '%'}
    )`))!)
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
  const tagsByLead = new Map<number, string[]>()
  if (leads.length) {
    const tags = await db
      .select({ leadId: leadTags.leadId, tag: leadTags.tag })
      .from(leadTags)
      .where(inArray(leadTags.leadId, leads.map(lead => lead.id)))
    for (const row of tags) {
      const current = tagsByLead.get(row.leadId) ?? []
      current.push(row.tag)
      tagsByLead.set(row.leadId, current)
    }
  }

  return NextResponse.json(leads.map(lead => ({ ...lead, tags: tagsByLead.get(lead.id) ?? [] })))
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
    tags: rawTags,
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
  const tags = Array.isArray(rawTags)
    ? [...new Set(rawTags.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 20)
    : []
  if (tags.some(tag => tag.length > 50)) {
    return NextResponse.json({ error: 'Cada tag pode ter no máximo 50 caracteres.' }, { status: 400 })
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
        ...(await getInheritedPauseFields(company.id, 'whatsapp')),
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

  if (tags.length && leadRecord) {
    const createdBy = 'cadastro_manual'
    await db.transaction(async tx => {
      for (const tag of tags) {
        await tx.insert(leadTags)
          .values({ leadId: leadRecord.id, tag, scopeChannel: null, createdBy })
          .onConflictDoNothing()
      }
      await tx.insert(sacAuditEvents).values({
        companyId: company.id,
        leadId: leadRecord.id,
        actorType: 'human',
        actorName: createdBy,
        type: 'lead_tags_created_with_lead',
        referenceType: 'lead',
        referenceId: String(leadRecord.id),
        payload: { tags, messagesCreated: 0, jobsCreated: 0 },
      })
    })
  }

  const currentTags = await db
    .select({ tag: leadTags.tag })
    .from(leadTags)
    .where(eq(leadTags.leadId, leadRecord.id))
  return NextResponse.json({ success: true, lead: { ...leadRecord, tags: currentTags.map(row => row.tag) } })
}
