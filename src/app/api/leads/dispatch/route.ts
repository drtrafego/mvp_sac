import { NextRequest, NextResponse } from 'next/server'
import { and, eq, gte, inArray, lte, or, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { massDispatchBatches, massDispatchRecipients, recoveryLeads, settings } from '@/lib/db/schema'
import { getDateRange } from '@/lib/date-utils'
import { channelWhereCondition } from '@/lib/inbox-channel-filter'
import { buildCanonicalSnapshot, extractBodyPlaceholders, hasDocumentHeader, hasUnsupportedDynamicComponents, metaTemplateKey } from '@/lib/meta-template-utils'
import { queueDirectTemplateMassDispatchBatch } from '@/lib/mass-dispatch'
import { MassDispatchTemplateSelection } from '@/lib/validations/mass-dispatch'
import { listMetaTemplates } from '@/lib/whatsapp/meta'
import { renderTemplateVariableTextStrict, unresolvedTemplateVariableKeys, type TemplateLead } from '@/lib/lead-template-variables'
import { POST as runDispatchCron } from '@/app/api/cron/route'

const MAX_MASS_IMPORT_ROWS = 5000

type DispatchFilter = Record<string, unknown>

function stringValue(filter: DispatchFilter, key: string): string {
  const value = filter[key]
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(filter: DispatchFilter, key: string): string[] {
  return [...new Set(stringValue(filter, key).split(',').map(value => value.trim()).filter(Boolean))]
}

function parseValueToCents(raw: string): number {
  const cleaned = raw.replace(/[^0-9,-.]/g, '').trim()
  if (!cleaned) return 0
  if (cleaned.includes(',')) return Math.round((parseFloat(cleaned.replace(/\./g, '').replace(',', '.')) || 0) * 100)
  return Math.round((parseFloat(cleaned) || 0) * 100)
}

function filterConditions(companyId: number, filter: DispatchFilter) {
  const eventTypes = stringList(filter, 'event_type')
  const statuses = stringList(filter, 'status')
  const products = stringList(filter, 'product')
  const sources = stringList(filter, 'source')
  const platforms = stringList(filter, 'platform')
  const channels = stringList(filter, 'channel')
  const paymentType = stringValue(filter, 'payment_type')
  const tags = stringList(filter, 'tag')
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
  ]
  if (eventTypes.length) conditions.push(inArray(recoveryLeads.eventType, eventTypes))
  if (statuses.length) conditions.push(or(...statuses.map(status => status === 'awaiting_contact'
    ? sql`(${recoveryLeads.status} IN ('pending', 'new', 'aguardando') OR ${recoveryLeads.status} IS NULL)`
    : eq(recoveryLeads.status, status)))!)
  if (sources.length) conditions.push(or(...sources.map(source => channelWhereCondition(source) ?? sql`${recoveryLeads.trackingSource} ILIKE ${'%' + source + '%'}`))!)
  if (platforms.length) conditions.push(inArray(recoveryLeads.platform, platforms))
  if (products.length) conditions.push(inArray(recoveryLeads.productName, products))
  if (channels.length) conditions.push(inArray(recoveryLeads.channel, channels))
  if (paymentType) conditions.push(eq(recoveryLeads.paymentType, paymentType))
  if (search) {
    const pattern = `%${search}%`
    conditions.push(sql`(${recoveryLeads.name} ILIKE ${pattern} OR ${recoveryLeads.phone} ILIKE ${pattern} OR ${recoveryLeads.email} ILIKE ${pattern})`)
  }
  if (tags.length) conditions.push(or(...tags.map(tag => sql`EXISTS (SELECT 1 FROM lead_tags WHERE lead_tags.lead_id = ${recoveryLeads.id} AND lead_tags.tag ILIKE ${'%' + tag + '%'})`))!)
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
  const action = input.action === undefined ? 'save_draft' : input.action
  if (action !== 'save_draft' && action !== 'start') return NextResponse.json({ error: 'Ação de disparo inválida' }, { status: 400 })
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
  if (!template.id) return NextResponse.json({ error: 'O template aprovado não possui ID oficial da Meta' }, { status: 409 })
  if (action === 'start' && (
    parsedTemplate.data.templateMetaId !== template.id
    || parsedTemplate.data.templateCategory !== template.category
  )) {
    return NextResponse.json({ error: 'A prévia não corresponde ao template aprovado selecionado; revise antes de confirmar' }, { status: 409 })
  }
  if (hasUnsupportedDynamicComponents(template.components ?? [], { allowDocumentHeader: true })) return NextResponse.json({ error: 'Templates com HEADER de mídia exceto DOCUMENT ou componentes dinâmicos não são suportados' }, { status: 400 })
  const documentHeaderRequired = hasDocumentHeader(template.components ?? [])
  if (documentHeaderRequired !== Boolean(parsedTemplate.data.templateHeaderDocument)) {
    return NextResponse.json({ error: documentHeaderRequired ? 'Informe link e filename do documento do HEADER do template.' : 'Este template não possui HEADER DOCUMENT.' }, { status: 400 })
  }
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
      sql`${recoveryLeads.phone} IS NOT NULL AND ${recoveryLeads.phone} != ''`,
    ))
    if (rows.length !== ids.length) return NextResponse.json({ error: 'Alguns leads não existem, não pertencem à empresa ou estão sem telefone' }, { status: 400 })
    leadIds = rows.map(row => row.id)
  } else {
    if (!input.filter || typeof input.filter !== 'object' || Array.isArray(input.filter)) return NextResponse.json({ error: 'Filtro inválido' }, { status: 400 })
    const rows = await db.select({ id: recoveryLeads.id }).from(recoveryLeads).where(and(...filterConditions(company.id, input.filter as DispatchFilter))).limit(MAX_MASS_IMPORT_ROWS + 1)
    if (rows.length > MAX_MASS_IMPORT_ROWS) return NextResponse.json({ error: `O filtro encontrou mais de ${MAX_MASS_IMPORT_ROWS} leads. Refine os filtros antes de criar o lote.` }, { status: 400 })
    leadIds = rows.map(row => row.id)
  }
  if (!leadIds.length) return NextResponse.json({ error: 'Nenhum lead elegível com telefone foi encontrado' }, { status: 409 })

  const templateSnapshot = buildCanonicalSnapshot(template, { headerDocument: parsedTemplate.data.templateHeaderDocument })
  if (action === 'start' && parsedTemplate.data.templateBodyText !== templateSnapshot.bodyText) {
    return NextResponse.json({ error: 'O corpo da prévia diverge do corpo oficial do template; revise antes de confirmar' }, { status: 409 })
  }
  const selectedLeads = await db.select({
    id: recoveryLeads.id,
    name: recoveryLeads.name,
    email: recoveryLeads.email,
    phone: recoveryLeads.phone,
    productName: recoveryLeads.productName,
    productValue: recoveryLeads.productValue,
    transactionId: recoveryLeads.transactionId,
    cpfCnpj: recoveryLeads.cpfCnpj,
    city: recoveryLeads.city,
    state: recoveryLeads.state,
    paymentType: recoveryLeads.paymentType,
    installments: recoveryLeads.installments,
    boletoCode: recoveryLeads.boletoCode,
    boletoUrl: recoveryLeads.boletoUrl,
    boletoExpiry: recoveryLeads.boletoExpiry,
    pixCode: recoveryLeads.pixCode,
    pixExpiry: recoveryLeads.pixExpiry,
    checkoutUrl: recoveryLeads.checkoutUrl,
    affiliateCode: recoveryLeads.affiliateCode,
  }).from(recoveryLeads).where(and(eq(recoveryLeads.companyId, company.id), inArray(recoveryLeads.id, leadIds)))
  const unresolvedByLead = selectedLeads.flatMap(lead => {
    const templateLead: TemplateLead = Object.fromEntries(Object.entries(lead).map(([key, value]) => [key, value == null ? '' : String(value)]))
    const preview = renderTemplateVariableTextStrict(templateSnapshot.bodyText, parsedTemplate.data.templateVariablesMap, templateLead)
    return unresolvedTemplateVariableKeys(preview)
  })
  const unresolved = [...new Set(unresolvedByLead)]
  if (unresolved.length) {
    return NextResponse.json({ error: `A prévia não pode ser enviada: ${unresolved.map(index => `{{${index}}}`).join(', ')} não foi resolvida para todos os destinatários. Escolha outra origem ou um valor fixo.` }, { status: 409 })
  }
  const [batch] = await db.insert(massDispatchBatches).values({
    companyId: company.id, fileName: 'Seleção interna de leads', eventType: 'mass_dispatch', trackingSource: 'internal_leads', status: 'draft', recipientCount: leadIds.length,
    dispatchSource: 'direct_template', templateName: template.name, templateLanguage: template.language,
    templateVariablesMap: parsedTemplate.data.templateVariablesMap,
    templateSnapshot,
    updatedAt: new Date(),
  }).returning({ id: massDispatchBatches.id })
  if (!batch) return NextResponse.json({ error: 'Não foi possível criar o lote' }, { status: 500 })
  await db.insert(massDispatchRecipients).values(leadIds.map(leadId => ({ batchId: batch.id, leadId }))).onConflictDoNothing()

  if (action === 'save_draft') {
    return NextResponse.json({ batchId: batch.id, status: 'draft', jobsCreated: 0, recipientCount: leadIds.length })
  }

  const queued = await queueDirectTemplateMassDispatchBatch(batch.id, company.id, config.metaPhoneNumberId, [{
    id: 0,
    order: 1,
    delayMinutes: 0,
    messageType: 'template',
    content: templateSnapshot.bodyText,
    templateName: template.name,
    templateLanguage: template.language,
    templateVariablesMap: parsedTemplate.data.templateVariablesMap,
  }])
  if (queued.status === 'daily_limit') {
    return NextResponse.json({ error: 'Limite técnico de volume nas últimas 24h atingido para este número', batchId: batch.id, status: 'draft', requested: queued.requested, available: queued.available }, { status: 429 })
  }
  if (queued.status === 'no_eligible_messages') {
    return NextResponse.json({ error: 'Nenhum destinatário é elegível para o disparo', batchId: batch.id, status: 'draft' }, { status: 409 })
  }
  if (queued.status === 'preview_changed') {
    return NextResponse.json({ error: 'A mensagem mudou depois da revisão; revise e tente novamente', batchId: batch.id, status: 'draft' }, { status: 409 })
  }
  if (queued.status === 'not_found_or_claimed') {
    return NextResponse.json({ error: 'O lote foi confirmado por outra requisição ou não pôde ser enfileirado', batchId: batch.id, status: 'draft' }, { status: 409 })
  }
  if (queued.status === 'non_template') {
    return NextResponse.json({ error: 'O template selecionado não pode ser enfileirado neste disparo', batchId: batch.id, status: 'draft' }, { status: 409 })
  }

  // O lote foi confirmado pelo clique em Leads. Processá-lo nesta mesma
  // requisição remove a espera pelo próximo Vercel Cron; o filtro batch_id
  // impede que este acionamento toque em outros jobs da fila.
  let workerTriggered = false
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret) {
    try {
      const workerRequest = new NextRequest(new URL(`/api/cron?batch_id=${batch.id}`, req.url), {
        method: 'POST',
        headers: { Authorization: `Bearer ${cronSecret}` },
      })
      const workerResponse = await runDispatchCron(workerRequest)
      workerTriggered = workerResponse.ok
      if (!workerResponse.ok) console.error('[mass-dispatch] worker imediato não concluiu', { batchId: batch.id, status: workerResponse.status })
    } catch (error) {
      console.error('[mass-dispatch] falha ao acionar worker imediato', { batchId: batch.id, error })
    }
  } else {
    console.error('[mass-dispatch] CRON_SECRET ausente; lote ficará para o cron agendado', { batchId: batch.id })
  }

  return NextResponse.json({ success: true, batchId: batch.id, status: 'queued', jobsCreated: queued.jobsCreated, recipientCount: leadIds.length, workerTriggered })
}
