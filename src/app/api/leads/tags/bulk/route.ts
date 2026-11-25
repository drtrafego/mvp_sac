import { NextRequest, NextResponse } from 'next/server'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { getCurrentUser, requireCompany } from '@/lib/auth'
import { leadTags, recoveryLeads, sacAuditEvents } from '@/lib/db/schema'
import { MAX_TAG_LENGTH, normalizeTag } from '@/lib/lead-tags'
import { getDateRange } from '@/lib/date-utils'

const MAX_SELECTED_LEADS = 5000
const MAX_TAGS_PER_ACTION = 20

type BulkAction = 'add' | 'remove' | 'replace'
type Selection = {
  mode?: 'ids' | 'filter'
  leadIds?: unknown
  filter?: Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizedTags(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return [...new Set(values
    .filter((tag): tag is string => typeof tag === 'string')
    .map(normalizeTag)
    .filter(Boolean))].slice(0, MAX_TAGS_PER_ACTION)
}

function filterConditions(companyId: number, filter: Record<string, unknown>) {
  const conditions = [eq(recoveryLeads.companyId, companyId)]
  const search = stringValue(filter.search)
  const eventType = stringValue(filter.event_type)
  const status = stringValue(filter.status)
  const source = stringValue(filter.source)
  const product = stringValue(filter.product)
  const platform = stringValue(filter.platform)
  const paymentType = stringValue(filter.payment_type)
  const tag = stringValue(filter.tag)
  const transactionId = stringValue(filter.transaction_id)
  const { fromDate, toDate } = getDateRange('30d', new Date(), stringValue(filter.from), stringValue(filter.to))

  if (eventType) conditions.push(eq(recoveryLeads.eventType, eventType))
  if (status) conditions.push(eq(recoveryLeads.status, status))
  if (source) conditions.push(sql`(${recoveryLeads.channel} = ${source} OR ${recoveryLeads.trackingSource} ILIKE ${'%' + source + '%'})`)
  if (product) conditions.push(eq(recoveryLeads.productName, product))
  if (platform) conditions.push(eq(recoveryLeads.platform, platform))
  if (paymentType) conditions.push(eq(recoveryLeads.paymentType, paymentType))
  if (search) {
    const pattern = `%${search}%`
    conditions.push(sql`(${recoveryLeads.name} ILIKE ${pattern} OR ${recoveryLeads.phone} ILIKE ${pattern} OR ${recoveryLeads.email} ILIKE ${pattern} OR ${recoveryLeads.productName} ILIKE ${pattern} OR ${recoveryLeads.transactionId} ILIKE ${pattern})`)
  }
  if (tag) conditions.push(sql`EXISTS (SELECT 1 FROM lead_tags WHERE lead_tags.lead_id = ${recoveryLeads.id} AND lead_tags.tag ILIKE ${'%' + tag + '%'})`)
  if (filter.has_tags === true || filter.has_tags === 'true') conditions.push(sql`EXISTS (SELECT 1 FROM lead_tags WHERE lead_tags.lead_id = ${recoveryLeads.id})`)
  if (filter.has_phone === true || filter.has_phone === 'true') conditions.push(sql`COALESCE(${recoveryLeads.phone}, '') <> ''`)
  if (filter.has_email === true || filter.has_email === 'true') conditions.push(sql`COALESCE(${recoveryLeads.email}, '') <> ''`)
  if (filter.is_sale === 'true') conditions.push(eq(recoveryLeads.status, 'converted'))
  if (filter.is_sale === 'false') conditions.push(sql`COALESCE(${recoveryLeads.status}, '') <> 'converted'`)
  if (transactionId) conditions.push(sql`${recoveryLeads.transactionId} ILIKE ${'%' + transactionId + '%'}`)
  if (fromDate) conditions.push(sql`${recoveryLeads.createdAt} >= ${fromDate}`)
  conditions.push(sql`${recoveryLeads.createdAt} <= ${toDate}`)

  return conditions
}

async function resolveLeadIds(companyId: number, selection: Selection): Promise<number[]> {
  if (selection.mode === 'filter') {
    const rows = await db
      .select({ id: recoveryLeads.id })
      .from(recoveryLeads)
      .where(and(...filterConditions(companyId, selection.filter ?? {})))
      .orderBy(recoveryLeads.id)
      .limit(MAX_SELECTED_LEADS + 1)
    if (rows.length > MAX_SELECTED_LEADS) throw new Error(`A seleção excede o limite seguro de ${MAX_SELECTED_LEADS} leads.`)
    return rows.map(row => row.id)
  }

  if (!Array.isArray(selection.leadIds) || selection.leadIds.length === 0 || selection.leadIds.length > MAX_SELECTED_LEADS) {
    throw new Error(`Selecione de 1 a ${MAX_SELECTED_LEADS} leads válidos.`)
  }
  const ids = [...new Set(selection.leadIds)]
  if (ids.some(id => !Number.isInteger(id) || id <= 0)) throw new Error('A seleção contém IDs de lead inválidos.')

  const rows = await db
    .select({ id: recoveryLeads.id })
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.companyId, companyId), inArray(recoveryLeads.id, ids as number[])))
  if (rows.length !== ids.length) throw new Error('Um ou mais leads não existem ou não pertencem à empresa selecionada.')
  return ids as number[]
}

function validateAction(body: Record<string, unknown>): { action: BulkAction; tags: string[]; fromTag?: string; toTag?: string } | { error: string } {
  const action = body.action
  if (action !== 'add' && action !== 'remove' && action !== 'replace') return { error: 'Ação de tags inválida.' }

  if (action === 'replace') {
    const fromTag = normalizeTag(stringValue(body.fromTag) ?? '')
    const toTag = normalizeTag(stringValue(body.toTag) ?? '')
    if (!fromTag || !toTag) return { error: 'Informe a tag de origem e a tag de destino.' }
    if (fromTag === toTag) return { error: 'A tag de origem e a tag de destino precisam ser diferentes.' }
    return { action, tags: [fromTag, toTag], fromTag, toTag }
  }

  const tags = normalizedTags(body.tags ?? body.tag)
  if (!tags.length) return { error: 'Informe uma ou mais tags.' }
  if (tags.some(tag => tag.length > MAX_TAG_LENGTH)) return { error: `Cada tag pode ter no máximo ${MAX_TAG_LENGTH} caracteres.` }
  return { action, tags }
}

async function preview(companyId: number, ids: number[], action: BulkAction, fromTag?: string) {
  const rows = ids.length
    ? await db.select({ leadId: leadTags.leadId, tag: leadTags.tag }).from(leadTags).where(and(inArray(leadTags.leadId, ids), ...(fromTag ? [eq(leadTags.tag, fromTag)] : [])))
    : []
  const leadsWithFromTag = fromTag ? new Set(rows.map(row => row.leadId)).size : undefined
  return {
    selectedCount: ids.length,
    fromTagCount: leadsWithFromTag ?? null,
    withoutFromTagCount: leadsWithFromTag == null ? null : ids.length - leadsWithFromTag,
    action,
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const company = await requireCompany()
    const body = await req.json().catch(() => null) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Body inválido.' }, { status: 400 })

    const checked = validateAction(body)
    if ('error' in checked) return NextResponse.json({ error: checked.error }, { status: 400 })

    const ids = await resolveLeadIds(company.id, {
      mode: body.mode === 'filter' ? 'filter' : 'ids',
      leadIds: body.leadIds,
      filter: typeof body.filter === 'object' && body.filter && !Array.isArray(body.filter) ? body.filter as Record<string, unknown> : undefined,
    })
    const summary = await preview(company.id, ids, checked.action, checked.fromTag)
    if (body.preview === true || body.confirm !== true) {
      return NextResponse.json({ ok: true, preview: true, ...summary, tags: checked.tags, fromTag: checked.fromTag ?? null, toTag: checked.toTag ?? null })
    }
    if (!ids.length) return NextResponse.json({ error: 'Nenhum lead corresponde à seleção.' }, { status: 409 })

    const user = await getCurrentUser()
    const actorName = user?.displayName || user?.primaryEmail?.split('@')[0] || 'humano'
    // Production uses neon-http, whose database wrapper does not implement
    // transactions. Keep each lead operation idempotent and tenant-scoped,
    // then write one audit event after the batch. A failed lead is isolated in
    // the result instead of aborting the whole request before any response.
    let altered = 0
    let ignored = 0
    const failed: Array<{ leadId: number; error: string }> = []

    for (const leadId of ids) {
      try {
        let changed = false
        if (checked.action === 'add') {
          for (const tag of checked.tags) {
            const inserted = await db.insert(leadTags).values({ leadId, tag, scopeChannel: null, createdBy: actorName }).onConflictDoNothing().returning({ id: leadTags.id })
            if (inserted.length) changed = true
          }
        } else if (checked.action === 'remove') {
          const deleted = await db.delete(leadTags).where(and(eq(leadTags.leadId, leadId), inArray(leadTags.tag, checked.tags))).returning({ id: leadTags.id })
          changed = deleted.length > 0
        } else {
          const deleted = await db.delete(leadTags).where(and(eq(leadTags.leadId, leadId), eq(leadTags.tag, checked.fromTag!))).returning({ id: leadTags.id })
          if (deleted.length) {
            await db.insert(leadTags).values({ leadId, tag: checked.toTag!, scopeChannel: null, createdBy: actorName }).onConflictDoNothing()
            changed = true
          }
        }
        if (changed) altered += 1
        else ignored += 1
      } catch (error) {
        failed.push({ leadId, error: error instanceof Error ? error.message : 'Falha ao alterar tags.' })
      }
    }

    await db.insert(sacAuditEvents).values({
      companyId: company.id,
      actorType: 'human',
      actorId: user?.id ? String(user.id) : null,
      actorName,
      type: 'lead_tags_bulk_updated',
      referenceType: 'lead_tags_bulk',
      payload: {
        action: checked.action,
        leadCount: ids.length,
        altered,
        ignored,
        failed: failed.length,
        tags: checked.tags,
        fromTag: checked.fromTag ?? null,
        toTag: checked.toTag ?? null,
        messagesCreated: 0,
        jobsCreated: 0,
      },
    })
    const result = { altered, ignored, failed }

    return NextResponse.json({ ok: true, preview: false, ...summary, ...result, messagesCreated: 0, jobsCreated: 0 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Não foi possível alterar as tags.'
    const status = /seleção|selecione|IDs|não pertencem|limite/i.test(message) ? 400 : 500
    console.error('[API /leads/tags/bulk]', error)
    return NextResponse.json({ error: message }, { status })
  }
}
