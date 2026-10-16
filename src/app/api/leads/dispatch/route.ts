import { NextRequest, NextResponse } from 'next/server'
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { massDispatchBatches, massDispatchRecipients, recoveryLeads, settings } from '@/lib/db/schema'
import { getDateRange } from '@/lib/date-utils'
import { channelWhereCondition } from '@/lib/inbox-channel-filter'
import { buildCanonicalSnapshot, extractBodyPlaceholders, hasUnsupportedDynamicComponents, metaTemplateKey } from '@/lib/meta-template-utils'
import { MassDispatchTemplateSelection } from '@/lib/validations/mass-dispatch'
import { listMetaTemplates } from '@/lib/whatsapp/meta'

const MAX_MASS_IMPORT_ROWS = 5000

type DispatchFilter = Record<string, unknown>

function stringValue(filter: DispatchFilter, key: string): string {
  const value = filter[key]
  return typeof value === 'string' ? value.trim() : ''
}

function parseValueToCents(raw: string): number {
  const cleaned = raw.replace(/[^0-9,-.]/g, '').trim()
  if (!cleaned) return 0
  if (cleaned.includes(',')) return Math.round((parseFloat(cleaned.replace(/\./g, '').replace(',', '.')) || 0) * 100)
  return Math.round((parseFloat(cleaned) || 0) * 100)
}

function filterConditions(companyId: number, filter: DispatchFilter) {
  const eventType = stringValue(filter, 'event_type')
  const status = stringValue(filter, 'status')
  const product = stringValue(filter, 'product')
  const source = stringValue(filter, 'source')
  const platform = stringValue(filter, 'platform')
  const paymentType = stringValue(filter, 'payment_type')
  const tag = stringValue(filter, 'tag')
  const transactionId = stringValue(filter, 'transaction_id')
  const search = stringValue(filter, 'search') || stringValue(filter, 'q')
  const minValue = stringValue(filter, 'min_value')
  const maxValue = stringValue(filter, 'max_value')
  const period = stringValue(filter, 'period') || '30d'
  const from = stringValue(filter, 'from') || undefined
  const to = stringValue(filter, 'to') || undefined
  const { fromDate, toDate } = getDateRange(period, new Date(), from, to)
  const conditions = [
    eq(recoveryLeads.companyId, companyId),
    sql`${recoveryLeads.phone} IS NOT NULL AND ${recoveryLeads.phone} != ''`,
    sql`${recoveryLeads.botPaused} IS NOT TRUE`,
  ]
  if (eventType) conditions.push(eq(recoveryLeads.eventType, eventType))
  if (status === 'awaiting_contact') conditions.push(sql`(${recoveryLeads.status} IN ('pending', 'new', 'aguardando') OR ${recoveryLeads.status} IS NULL)`)
  else if (status) conditions.push(eq(recoveryLeads.status, status))
  if (source) conditions.push(channelWhereCondition(source) ?? sql`${recoveryLeads.trackingSource} ILIKE ${'%' + source + '%'}`)
  if (platform) conditions.push(eq(recoveryLeads.platform, platform))
  if (product) conditions.push(eq(recoveryLeads.productName, product))
  if (paymentType) conditions.push(eq(recoveryLeads.paymentType, paymentType))
  if (search) {
    const pattern = `%${search}%`
    conditions.push(sql`(${recoveryLeads.name} ILIKE ${pattern} OR ${recoveryLeads.phone} ILIKE ${pattern} OR ${recoveryLeads.email} ILIKE ${pattern} OR ${recoveryLeads.productName} ILIKE ${pattern} OR ${recoveryLeads.transactionId} ILIKE ${pattern})`)
  }
  if (tag) conditions.push(sql`EXISTS (SELECT 1 FROM lead_tags WHERE lead_tags.lead_id = ${recoveryLeads.id} AND lead_tags.tag ILIKE ${'%' + tag + '%'})`)
  if (filter.has_tags === true || filter.has_tags === 'true') conditions.push(sql`EXISTS (SELECT 1 FROM lead_tags WHERE lead_tags.lead_id = ${recoveryLeads.id})`)
  if (filter.has_email === true || filter.has_email === 'true') conditions.push(sql`(${recoveryLeads.email} IS NOT NULL AND ${recoveryLeads.email} != '')`)
  if (filter.is_sale === true || filter.is_sale === 'true') conditions.push(eq(recoveryLeads.status, 'converted'))
  if (filter.is_sale === false || filter.is_sale === 'false') conditions.push(sql`COALESCE(${recoveryLeads.status}, '') != 'converted'`)
  if (transactionId) conditions.push(sql`${recoveryLeads.transactionId} ILIKE ${'%' + transactionId + '%'}`)
  const minCents = parseValueToCents(minValue)
  const maxCents = parseValueToCents(maxValue)
  if (minCents > 0) conditions.push(gte(recoveryLeads.productValue, minCents))
  if (maxCents > 0) conditions.push(lte(recoveryLeads.productValue, maxCents))
  if (!search) {
    if (fromDate) conditions.push(gte(recoveryLeads.createdAt, fromDate))
    conditions.push(lte(recoveryLeads.createdAt, toDate))
  } else if (from && fromDate) {
    conditions.push(gte(recoveryLeads.createdAt, fromDate))
    conditions.push(lte(recoveryLeads.createdAt, toDate))
  }
  return conditions
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const body: unknown = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 })
  const input = body as Record<string, unknown>
  const mode = input.mode
  if (mode !== 'ids' && mode !== 'filter') return NextResponse.json({ error: 'Modo de seleção inválido' }, { status: 400 })
  const parsedTemplate = MassDispatchTemplateSelection.safeParse(input.template)
  if (!parsedTemplate.success) return NextResponse.json({ error: 'Configuração do template inválida' }, { status: 400 })

  const [config] = await db.select().from(settings).where(eq(settings.companyId, company.id)).limit(1)
  if (!config || (config.whatsappProvider ?? 'meta') !== 'meta' || !config.metaWabaId || !config.metaPhoneNumberId || !config.metaAccessToken) {
    return NextResponse.json({ error: 'Disparo em massa exige Meta Cloud API configurada com WABA ID, número e token de acesso' }, { status: 409 })
  }
  let template: Awaited<ReturnType<typeof listMetaTemplates>>[number]
  try {
    const templates = await listMetaTemplates(config.metaWabaId, config.metaAccessToken)
    template = templates.find(candidate => metaTemplateKey(candidate.name, candidate.language) === metaTemplateKey(parsedTemplate.data.templateName, parsedTemplate.data.templateLanguage))!
  } catch (error) {
    console.error('[mass-dispatch] falha ao validar template Meta', error)
    return NextResponse.json({ error: 'Não foi possível validar o template aprovado na Meta' }, { status: 503 })
  }
  if (!template) return NextResponse.json({ error: 'O template selecionado não está aprovado na Meta' }, { status: 409 })
  if (hasUnsupportedDynamicComponents(template.components ?? [])) return NextResponse.json({ error: 'Templates com HEADER de mídia ou componentes dinâmicos não são suportados' }, { status: 400 })
  const expectedIndexes = extractBodyPlaceholders(template.components ?? [])
  const mappedIndexes = Object.keys(parsedTemplate.data.templateVariablesMap).map(Number).sort((a, b) => a - b)
  if (expectedIndexes.length !== mappedIndexes.length || expectedIndexes.some((index, position) => index !== mappedIndexes[position])) {
    return NextResponse.json({ error: 'Mapeie todas e somente as variáveis do BODY do template selecionado' }, { status: 400 })
  }

  let leadIds: number[]
  if (mode === 'ids') {
    if (!Array.isArray(input.leadIds) || input.leadIds.length === 0 || input.leadIds.length > MAX_MASS_IMPORT_ROWS || input.leadIds.some(id => !Number.isInteger(id) || id <= 0)) {
      return NextResponse.json({ error: `Selecione de 1 a ${MAX_MASS_IMPORT_ROWS} leads válidos` }, { status: 400 })
    }
    const ids = [...new Set(input.leadIds as number[])]
    const rows = await db.select({ id: recoveryLeads.id }).from(recoveryLeads).where(and(
      eq(recoveryLeads.companyId, company.id), inArray(recoveryLeads.id, ids),
      sql`${recoveryLeads.phone} IS NOT NULL AND ${recoveryLeads.phone} != ''`, sql`${recoveryLeads.botPaused} IS NOT TRUE`,
    ))
    if (rows.length !== ids.length) return NextResponse.json({ error: 'Alguns leads não existem, não pertencem à empresa, estão sem telefone ou pausados' }, { status: 400 })
    leadIds = rows.map(row => row.id)
  } else {
    if (!input.filter || typeof input.filter !== 'object' || Array.isArray(input.filter)) return NextResponse.json({ error: 'Filtro inválido' }, { status: 400 })
    const rows = await db.select({ id: recoveryLeads.id }).from(recoveryLeads).where(and(...filterConditions(company.id, input.filter as DispatchFilter))).limit(MAX_MASS_IMPORT_ROWS + 1)
    if (rows.length > MAX_MASS_IMPORT_ROWS) return NextResponse.json({ error: `O filtro encontrou mais de ${MAX_MASS_IMPORT_ROWS} leads. Refine os filtros antes de criar o lote.` }, { status: 400 })
    leadIds = rows.map(row => row.id)
  }
  if (!leadIds.length) return NextResponse.json({ error: 'Nenhum lead elegível com telefone foi encontrado' }, { status: 409 })

  const [batch] = await db.insert(massDispatchBatches).values({
    companyId: company.id, fileName: 'Seleção interna de leads', eventType: 'mass_dispatch', trackingSource: 'internal_leads', status: 'draft', recipientCount: leadIds.length,
    dispatchSource: 'direct_template', templateName: template.name, templateLanguage: template.language,
    templateVariablesMap: parsedTemplate.data.templateVariablesMap, templateSnapshot: buildCanonicalSnapshot(template), updatedAt: new Date(),
  }).returning({ id: massDispatchBatches.id })
  if (!batch) return NextResponse.json({ error: 'Não foi possível criar o lote' }, { status: 500 })
  await db.insert(massDispatchRecipients).values(leadIds.map(leadId => ({ batchId: batch.id, leadId }))).onConflictDoNothing()
  return NextResponse.json({ batchId: batch.id, recipientCount: leadIds.length })
}
