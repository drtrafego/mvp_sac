import { getInheritedPauseFields } from '@/lib/bot-pause'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { leadTags, massDispatchBatches, massDispatchRecipients, messageJobs, recoveryLeads, settings } from '@/lib/db/schema'
import { desc, eq, and, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { isLeadChannel, MAX_TAG_LENGTH, normalizeTag, PESSOA_TAG, type LeadChannel } from '@/lib/lead-tags'
import { pauseBotForPessoaTag } from '@/lib/pessoa-tag-pause'
import { formatBrazilianPhone } from '@/lib/phone'
import { listMetaTemplates } from '@/lib/whatsapp/meta'
import { buildCanonicalSnapshot, extractBodyPlaceholders, hasDocumentHeader, hasUnsupportedDynamicComponents, metaTemplateKey } from '@/lib/meta-template-utils'
import { MassDispatchTemplateSelection } from '@/lib/validations/mass-dispatch'
import { deriveMassDispatchDisplayStatus } from '@/lib/mass-dispatch'

function parseValueToCents(raw: string | number | null | undefined): number {
  if (raw == null) return 0
  if (typeof raw === 'number') return Math.round(raw * 100)
  const cleaned = raw.replace(/[^0-9,-.]/g, '').trim()
  if (!cleaned) return 0
  if (cleaned.includes(',')) {
    const norm = cleaned.replace(/\./g, '').replace(',', '.')
    return Math.round(parseFloat(norm) * 100) || 0
  }
  return Math.round(parseFloat(cleaned) * 100) || 0
}

interface ImportItem {
  name?: string
  phone: string
  email?: string
  productName?: string
  productValue?: string | number
  eventType?: string
  recordType?: 'lead' | 'closed_sale'
  platform?: string
  trackingSource?: string
  tags?: string[]
  preserveExistingProductName?: boolean
  preserveExistingTrackingSource?: boolean
  sourceMetadata?: Record<string, string | number | boolean | null | undefined>
}

type ImportedMetadata = { import: Record<string, unknown> } | undefined

function mergeImportedRawPayload(existing: unknown, imported: ImportedMetadata) {
  if (!imported || !Object.values(imported.import).some(Boolean)) return existing
  const current = existing && typeof existing === 'object' && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {}
  const currentImport = current.import && typeof current.import === 'object' && !Array.isArray(current.import)
    ? current.import as Record<string, unknown>
    : {}
  const incomingImport = Object.fromEntries(
    Object.entries(imported.import).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  )
  return {
    ...current,
    import: {
      ...currentImport,
      ...incomingImport,
    },
  }
}

export async function GET(): Promise<NextResponse> {
  const company = await requireCompany()
  const batches = await db
    .select({
      id: massDispatchBatches.id,
      fileName: massDispatchBatches.fileName,
      recipientCount: massDispatchBatches.recipientCount,
      status: massDispatchBatches.status,
      createdAt: massDispatchBatches.createdAt,
      confirmedAt: massDispatchBatches.confirmedAt,
    })
    .from(massDispatchBatches)
    .where(eq(massDispatchBatches.companyId, company.id))
    .orderBy(desc(massDispatchBatches.createdAt))
    .limit(50)

  const statsRows = await db
    .select({
      batchId: messageJobs.massDispatchBatchId,
      status: messageJobs.status,
      deliveryStatus: messageJobs.deliveryStatus,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(messageJobs)
    .innerJoin(massDispatchBatches, eq(messageJobs.massDispatchBatchId, massDispatchBatches.id))
    .where(eq(massDispatchBatches.companyId, company.id))
    .groupBy(messageJobs.massDispatchBatchId, messageJobs.status, messageJobs.deliveryStatus)

  const statsByBatch = new Map<number, { pending: number; sent: number; failed: number; total: number }>()
  const jobsByBatch = new Map<number, Array<{ status: string | null; deliveryStatus: string | null }>>()
  for (const row of statsRows) {
    if (!row.batchId) continue
    const jobs = jobsByBatch.get(row.batchId) ?? []
    jobs.push(...Array.from({ length: Number(row.count) || 0 }, () => ({ status: row.status, deliveryStatus: row.deliveryStatus })))
    jobsByBatch.set(row.batchId, jobs)
    const stats = statsByBatch.get(row.batchId) ?? { pending: 0, sent: 0, failed: 0, total: 0 }
    const count = Number(row.count) || 0
    stats.total += count
    if (row.status === 'sent') stats.sent += count
    else if (row.status === 'failed') stats.failed += count
    else if (row.status === 'pending' || row.status === 'processing') stats.pending += count
    statsByBatch.set(row.batchId, stats)
  }

  return NextResponse.json({
    batches: batches.map(batch => ({
      ...batch,
      status: deriveMassDispatchDisplayStatus(jobsByBatch.get(batch.id) ?? [], batch.status),
      stats: statsByBatch.get(batch.id) ?? { pending: 0, sent: 0, failed: 0, total: 0 },
    })),
  })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const body = await req.json()

  const {
    items,
    defaultEventType: rawDefaultEventType,
    defaultSource: rawDefaultSource = 'mineracao',
    fileName,
    createMassDispatch,
    massDispatch,
    triggerMassDispatch,
    massDispatchTemplate: rawMassDispatchTemplate,
    recordType: rawRecordType,
    platform: rawPlatform,
    tag: rawTag,
    scopeChannel: rawScopeChannel,
  } = body

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: 'Nenhum contato enviado para importação' }, { status: 400 })
  }
  const MAX_MASS_IMPORT_ROWS = 5000
  if (items.length > MAX_MASS_IMPORT_ROWS) {
    return NextResponse.json({ error: `O limite é ${MAX_MASS_IMPORT_ROWS} contatos por importação; envie ${items.length} em lotes menores` }, { status: 400 })
  }

  const hasTag = rawTag !== undefined && rawTag !== null && rawTag !== ''
  const tag = hasTag && typeof rawTag === 'string' ? normalizeTag(rawTag) : null
  if (hasTag && !tag) {
    return NextResponse.json({ error: `Tag inválida (vazia ou só espaço, máx. ${MAX_TAG_LENGTH} caracteres)` }, { status: 400 })
  }

  let scopeChannel: LeadChannel | null = null
  if (rawScopeChannel !== undefined && rawScopeChannel !== null) {
    if (!tag || !isLeadChannel(rawScopeChannel)) {
      return NextResponse.json({ error: 'Canal de escopo inválido ou informado sem tag' }, { status: 400 })
    }
    scopeChannel = rawScopeChannel
  }

  let inserted = 0
  let updated = 0
  let skipped = 0
  let tagFailed = 0
  let dispatchRecipientFailed = 0
  let alreadyExisting = 0
  const errors: string[] = []

  const shouldCreateMassDispatch = Boolean(createMassDispatch || massDispatch || triggerMassDispatch)
  const recordType = rawRecordType === 'closed_sale' ? 'closed_sale' : 'lead'
  const platform = typeof rawPlatform === 'string' && rawPlatform.trim() ? rawPlatform.trim() : 'import_planilha'
  const defaultEventType = typeof rawDefaultEventType === 'string' ? rawDefaultEventType.trim() : ''
  const defaultSource = typeof rawDefaultSource === 'string' && rawDefaultSource.trim()
    ? rawDefaultSource.trim()
    : 'mineracao'
  const importEventType = defaultEventType || 'atendimento'

  const parsedMassDispatchTemplate = rawMassDispatchTemplate === undefined
    ? null
    : MassDispatchTemplateSelection.safeParse(rawMassDispatchTemplate)
  if (parsedMassDispatchTemplate && !parsedMassDispatchTemplate.success) {
    return NextResponse.json({ error: 'Configuração do template de disparo inválida' }, { status: 400 })
  }
  const massDispatchTemplate = parsedMassDispatchTemplate?.data ?? null

  if (shouldCreateMassDispatch && !massDispatchTemplate && !defaultEventType) {
    return NextResponse.json({ error: 'Selecione o tipo de evento para preparar o disparo em massa' }, { status: 400 })
  }

  if (recordType === 'closed_sale' && shouldCreateMassDispatch) {
    return NextResponse.json({ error: 'Vendas fechadas não podem entrar em disparo de recuperação' }, { status: 400 })
  }

  let directTemplate: {
    name: string
    language: string
    variablesMap: Record<string, string>
    snapshot: ReturnType<typeof buildCanonicalSnapshot>
  } | null = null
  if (massDispatchTemplate) {
    const [config] = await db.select().from(settings).where(eq(settings.companyId, company.id)).limit(1)
    if (!config || (config.whatsappProvider ?? 'meta') !== 'meta' || !config.metaWabaId || !config.metaPhoneNumberId || !config.metaAccessToken) {
      return NextResponse.json({
        error: 'Disparo em massa com template exige Meta Cloud API configurada com WABA ID, número e token de acesso',
      }, { status: 409 })
    }

    try {
      const templates = await listMetaTemplates(config.metaWabaId, config.metaAccessToken)
      const template = templates.find(candidate =>
        metaTemplateKey(candidate.name, candidate.language) === metaTemplateKey(massDispatchTemplate.templateName, massDispatchTemplate.templateLanguage)
      )
      if (!template) {
        return NextResponse.json({ error: 'O template selecionado não está aprovado na Meta' }, { status: 409 })
      }
      if (hasUnsupportedDynamicComponents(template.components ?? [], { allowDocumentHeader: true })) {
        return NextResponse.json({ error: 'Templates com HEADER de mídia exceto DOCUMENT ou BUTTON dinâmico ainda não são suportados no disparo em massa' }, { status: 409 })
      }
      const documentHeaderRequired = hasDocumentHeader(template.components ?? [])
      if (documentHeaderRequired !== Boolean(massDispatchTemplate.templateHeaderDocument)) {
        return NextResponse.json({ error: documentHeaderRequired ? 'Informe link e filename do documento do HEADER do template.' : 'Este template não possui HEADER DOCUMENT.' }, { status: 400 })
      }

      const expectedIndexes = extractBodyPlaceholders(template.components ?? [])
      const mappedIndexes = Object.keys(massDispatchTemplate.templateVariablesMap).map(Number).sort((a, b) => a - b)
      if (expectedIndexes.length !== mappedIndexes.length || expectedIndexes.some((index, position) => index !== mappedIndexes[position])) {
        return NextResponse.json({ error: 'Mapeie todas e somente as variáveis do BODY do template selecionado' }, { status: 400 })
      }
      directTemplate = {
        name: template.name,
        language: template.language,
        variablesMap: massDispatchTemplate.templateVariablesMap,
        snapshot: buildCanonicalSnapshot(template, { headerDocument: massDispatchTemplate.templateHeaderDocument }),
      }
    } catch (err) {
      console.error('[mass-dispatch] falha ao validar template da Meta antes da importação', err)
      return NextResponse.json({ error: 'Não foi possível validar o template aprovado na Meta; nenhum lead foi importado' }, { status: 503 })
    }
  }

  const [batch] = shouldCreateMassDispatch
    ? await db.insert(massDispatchBatches).values({
        companyId: company.id,
        fileName: typeof fileName === 'string' ? fileName.slice(0, 255) : null,
        eventType: directTemplate ? 'mass_dispatch' : defaultEventType,
        trackingSource: defaultSource,
        status: 'draft',
        dispatchSource: directTemplate ? 'direct_template' : 'sequence',
        templateName: directTemplate?.name ?? null,
        templateLanguage: directTemplate?.language ?? null,
        templateVariablesMap: directTemplate?.variablesMap ?? null,
        templateSnapshot: directTemplate?.snapshot ?? null,
        updatedAt: new Date(),
      }).returning({ id: massDispatchBatches.id })
    : []

  if (shouldCreateMassDispatch && !batch) {
    return NextResponse.json({ error: 'Não foi possível criar o lote de disparo em massa' }, { status: 500 })
  }

  for (const item of items as ImportItem[]) {
    try {
      if (!item.phone || typeof item.phone !== 'string') {
        skipped++
        continue
      }

      const phone = formatBrazilianPhone(item.phone)
      if (phone.length < 10) {
        skipped++
        errors.push(`Telefone inválido: "${item.phone}"`)
        continue
      }

      const name = item.name?.trim() || null
      const email = item.email?.trim() || null
      const importedProductName = item.productName?.trim() || null
      const productName = importedProductName || 'Produto Principal'
      const productValue = parseValueToCents(item.productValue)
      // Importações simples ficam sem evento de recuperação específico. O
      // banco exige um valor, então usamos a categoria neutra de atendimento;
      // o evento escolhido só entra quando há lote de disparo.
      const itemEventType = typeof item.eventType === 'string' ? item.eventType.trim() : ''
      const eventType = recordType === 'closed_sale'
        ? 'compra_aprovada'
        : shouldCreateMassDispatch
        ? itemEventType || importEventType
        : importEventType
      const importedTrackingSource = typeof item.trackingSource === 'string' ? item.trackingSource.trim() : ''
      const trackingSource = importedTrackingSource || defaultSource
      const itemPlatform = typeof item.platform === 'string' && item.platform.trim() ? item.platform.trim() : platform
      const itemTags = Array.isArray(item.tags)
        ? [...new Set(item.tags
            .filter((value): value is string => typeof value === 'string')
            .map(value => normalizeTag(value))
            .filter(Boolean))]
        : []
      const importedMetadata = item.sourceMetadata && Object.values(item.sourceMetadata).some(Boolean)
        ? { import: { ...item.sourceMetadata, recordType, platform: itemPlatform } }
        : undefined

      // Verificar existência por telefone e empresa para idempotência
      const existing = await db
        .select({
          id: recoveryLeads.id,
          status: recoveryLeads.status,
          phone: recoveryLeads.phone,
          channel: recoveryLeads.channel,
          rawPayload: recoveryLeads.rawPayload,
        })
        .from(recoveryLeads)
        .where(and(eq(recoveryLeads.companyId, company.id), eq(recoveryLeads.phone, phone)))
        .orderBy(recoveryLeads.id)

      let targetLeads: Array<{ id: number; phone: string; channel: string | null }>

      if (existing.length > 0) {
        // Registros históricos duplicados continuam vivos para preservar
        // mensagens/auditoria. O import deve reconciliar todos eles, sem
        // criar outra linha nem deixar uma cópia sem as tags da planilha.
        for (const current of existing) {
          await db
            .update(recoveryLeads)
            .set({
              name: name ?? undefined,
              email: email ?? undefined,
              productName: item.preserveExistingProductName ? undefined : importedProductName ?? undefined,
              productValue: productValue > 0 ? productValue : undefined,
              platform: recordType === 'closed_sale' ? itemPlatform : undefined,
              eventType: recordType === 'closed_sale' ? eventType : undefined,
              status: recordType === 'closed_sale' ? 'completed' : undefined,
              pipelineStage: recordType === 'closed_sale' ? 'fechado' : undefined,
              trackingSource: item.preserveExistingTrackingSource ? undefined : trackingSource,
              rawPayload: mergeImportedRawPayload(current.rawPayload, importedMetadata),
              updatedAt: new Date(),
            })
            .where(eq(recoveryLeads.id, current.id))
        }

        targetLeads = existing.map(current => ({ id: current.id, phone: current.phone, channel: current.channel }))
        alreadyExisting++
        updated++
      } else {
        const [created] = await db
          .insert(recoveryLeads)
          .values({
            ...(await getInheritedPauseFields(company.id, 'whatsapp')),
            companyId: company.id,
            platform: itemPlatform,
            eventType,
            phone,
            name,
            email,
            productName,
            productValue,
            trackingSource,
            rawPayload: importedMetadata,
            status: recordType === 'closed_sale' ? 'completed' : 'pending',
            pipelineStage: recordType === 'closed_sale' ? 'fechado' : undefined,
          })
          .onConflictDoUpdate({
            target: [recoveryLeads.companyId, recoveryLeads.phone],
            targetWhere: sql`${recoveryLeads.platform} in ('instagram', 'sac', 'hermes', 'import_planilha')`,
            set: {
              name: name ? sql`coalesce(nullif(${recoveryLeads.name}, ''), ${name})` : undefined,
              email: email ? sql`coalesce(nullif(${recoveryLeads.email}, ''), ${email})` : undefined,
              productName: productName ? sql`coalesce(nullif(${recoveryLeads.productName}, ''), ${productName})` : undefined,
              productValue: productValue > 0 ? sql`coalesce(${recoveryLeads.productValue}, ${productValue})` : undefined,
              trackingSource: trackingSource ? sql`coalesce(nullif(${recoveryLeads.trackingSource}, ''), ${trackingSource})` : undefined,
              updatedAt: new Date(),
            },
          })
          .returning({
            id: recoveryLeads.id,
            phone: recoveryLeads.phone,
            channel: recoveryLeads.channel,
          })

        targetLeads = [{ id: created.id, phone: created.phone, channel: created.channel }]
        inserted++
      }

      const tagsToApply = [...new Set([...itemTags, ...(tag ? [tag] : [])])]
      for (const target of targetLeads) {
        for (const tagToApply of tagsToApply) {
          try {
            await db
              .insert(leadTags)
              .values({ leadId: target.id, tag: tagToApply, scopeChannel: tagToApply === tag ? scopeChannel : null, createdBy: 'import:csv' })
              .onConflictDoNothing()

            if (tagToApply === PESSOA_TAG) {
              await pauseBotForPessoaTag({ id: target.id, phone: target.phone, channel: target.channel })
            }
          } catch (err) {
            // O lead já foi persistido de verdade. Não o classificar como
            // skipped: isso sugeriria que nada aconteceu e falsearia os
            // contadores. A falha da tag tem categoria própria e inserted /
            // updated continuam descrevendo corretamente o estado do banco.
            tagFailed++
            errors.push(`Lead ${target.id} persistido, mas falhou ao aplicar a tag "${tagToApply}": ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }

      if (batch) {
        try {
          // A pausa controla o agente automático; não impede cadastro nem a
          // inclusão do lead em uma campanha/lote operacional.
          await db.insert(massDispatchRecipients)
            // Uma campanha tem um destinatário por item importado. Em uma
            // duplicidade histórica, usa o registro canônico mais antigo,
            // enquanto as tags acima continuam reconciliando todas as cópias.
            .values({ batchId: batch.id, leadId: targetLeads[0].id })
            .onConflictDoNothing()
        } catch (err) {
          dispatchRecipientFailed++
          errors.push(`Lead ${targetLeads[0].id} persistido, mas falhou ao incluir no lote de disparo: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } catch (err) {
      skipped++
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  let recipientCount = 0
  if (batch) {
    const [recipientTotal] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(massDispatchRecipients)
      .where(eq(massDispatchRecipients.batchId, batch.id))

    recipientCount = recipientTotal?.count ?? 0
    await db.update(massDispatchBatches)
      .set({ recipientCount })
      .where(eq(massDispatchBatches.id, batch.id))
  }

  return NextResponse.json({
    success: true,
    batchId: batch?.id ?? null,
    batchStatus: batch ? 'draft' : null,
    recipientCount,
    total: items.length,
    inserted,
    updated,
    alreadyExisting,
    skipped,
    tagFailed,
    dispatchRecipientFailed,
    errors: errors.slice(0, 10),
  })
}
