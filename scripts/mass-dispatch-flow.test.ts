/* eslint-disable @typescript-eslint/no-explicit-any -- harness mínimo para simular a API fluente do Drizzle e contextos Next sem rede/banco real */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as schema from '../src/lib/db/schema'

type Phase =
  | 'idle'
  | 'import-invalid'
  | 'empty-preview'
  | 'import-happy'
  | 'happy-preview'
  | 'happy-confirm'
  | 'cron'

let phase: Phase = 'idle'
let recoverySelectCount = 0
let messageJobSelectCount = 0
let queuedJobs = 0
let confirmationAttempts = 0
let confirmationExecuteCalls = 0
let sendCalls = 0
let releasedLocks = 0
const recipientLeadIds = new Set<number>()
const jobUpdates: Array<Record<string, unknown>> = []

const company = { id: 7, name: 'Empresa Teste', slug: 'empresa-teste' }
const validLead = {
  id: 101,
  companyId: company.id,
  platform: 'import_planilha',
  eventType: 'carrinho_abandonado',
  phone: '5511999990001',
  name: 'Lead Duplicado',
  email: null,
  productName: 'Produto Principal',
  productValue: 1000,
  trackingSource: 'mineracao',
  status: 'pending',
  channel: 'whatsapp',
  botPaused: false,
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
}
const emptyBatch = {
  id: 2,
  companyId: company.id,
  fileName: 'invalido.csv',
  eventType: 'carrinho_abandonado',
  trackingSource: 'mineracao',
  status: 'draft',
  recipientCount: 0,
}
const happyBatch = {
  id: 1,
  companyId: company.id,
  fileName: 'leads.csv',
  eventType: 'carrinho_abandonado',
  trackingSource: 'mineracao',
  status: 'draft',
  recipientCount: 1,
}
const previewRow = {
  recipient_count: 1,
  id: 301,
  order: 1,
  delay_minutes: 0,
  message_type: 'template',
  content: 'Olá {nome}',
  template_name: 'campanha_aprovada',
  template_language: 'pt_BR',
  template_variables_map: { '1': '{nome}' },
}
const messageSnapshot = {
  messageType: 'template',
  content: 'Olá {nome}',
  mediaUrl: null,
  caption: null,
  buttonsJson: null,
  templateName: 'campanha_aprovada',
  templateLanguage: 'pt_BR',
  templateVariablesMap: { '1': '{nome}' },
}
const queuedJob = {
  id: 501,
  leadId: validLead.id,
  // Template direto de lote é persistido como snapshot e não referencia uma
  // sequence_message. O cron precisa enviá-lo, não classificá-lo como inválido.
  messageId: null,
  messageOrder: 1,
  scheduledFor: new Date('2026-10-01T10:00:00.000Z'),
  sentAt: null,
  status: 'pending',
  error: null,
  checkBeforeSend: true,
  externalWamid: null,
  deliveryStatus: null,
  massDispatchBatchId: happyBatch.id,
  messageSnapshot,
  retryCount: 0,
  processingStartedAt: null,
  upsellContent: null,
}
const settingsRow = {
  companyId: company.id,
  whatsappProvider: 'meta',
  metaWabaId: 'waba-test',
  metaPhoneNumberId: 'phone-number-test',
  metaAccessToken: 'token-test',
  availabilitySchedule: null,
  availabilityScheduleManual: false,
}

function builder(resolveValue: () => unknown): any {
  const value: any = {
    from: () => value,
    where: () => value,
    limit: () => value,
    groupBy: () => value,
    innerJoin: () => value,
    leftJoin: () => value,
    orderBy: () => value,
    for: () => value,
    returning: () => value,
    onConflictDoNothing: () => value,
    onConflictDoUpdate: () => value,
    set: () => value,
    values: () => value,
    then: (resolve: (result: unknown) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve().then(resolveValue).then(resolve, reject),
  }
  return value
}

function resolveSelect(table: unknown): unknown[] {
  if (phase === 'import-happy') {
    if (table === schema.recoveryLeads) {
      recoverySelectCount++
      if (recoverySelectCount === 1) return []
      if (recoverySelectCount === 2) return [{ botPaused: false }]
      if (recoverySelectCount === 3) return [validLead]
      if (recoverySelectCount === 4) return [{ botPaused: false }]
    }
    if (table === schema.massDispatchRecipients) return [{ count: recipientLeadIds.size }]
  }

  if (phase === 'import-invalid' && table === schema.massDispatchRecipients) return [{ count: 0 }]

  if (phase === 'empty-preview') {
    if (table === schema.massDispatchBatches) return [emptyBatch]
    if (table === schema.messageJobs) return []
  }

  if (phase === 'happy-preview' || phase === 'happy-confirm') {
    if (table === schema.massDispatchBatches) return [happyBatch]
    if (table === schema.messageJobs) return []
    if (table === schema.settings) return [settingsRow]
  }

  if (phase === 'cron') {
    if (table === schema.whatsappMessages || table === schema.agendaBlockedDates) return []
    if (table === schema.messageJobs) {
      messageJobSelectCount++
      // O cron relê o estado antes de enviar e imediatamente antes do
      // transporte; só a consulta final, de jobs remanescentes, fica vazia.
      return messageJobSelectCount <= 2 ? [{ status: 'processing' }] : []
    }
    if (table === schema.recoveryLeads) {
      recoverySelectCount++
      if (recoverySelectCount === 1) return [] // nenhuma compra posterior ao lead
      if (recoverySelectCount === 2) return [validLead]
      return [{ status: 'in_progress' }]
    }
  }

  return []
}

function selectBuilder(): any {
  let table: unknown
  const value = builder(() => resolveSelect(table))
  value.from = (selectedTable: unknown) => {
    table = selectedTable
    return value
  }
  return value
}

function insertBuilder(table: unknown): any {
  let insertedValues: any
  const value = builder(() => {
    if (table === schema.massDispatchBatches) {
      return [{ id: phase === 'import-invalid' ? emptyBatch.id : happyBatch.id }]
    }
    if (table === schema.recoveryLeads) return [validLead]
    if (table === schema.massDispatchRecipients) {
      recipientLeadIds.add(insertedValues.leadId)
      return []
    }
    return []
  })
  value.values = (nextValues: unknown) => {
    insertedValues = nextValues
    return value
  }
  return value
}

function updateBuilder(table: unknown): any {
  let updateValues: Record<string, unknown> = {}
  const value = builder(() => {
    if (table === schema.messageJobs) jobUpdates.push(updateValues)
    return []
  })
  value.set = (nextValues: Record<string, unknown>) => {
    updateValues = nextValues
    return value
  }
  return value
}

const fakeDb = {
  select: () => selectBuilder(),
  insert: (table: unknown) => insertBuilder(table),
  update: (table: unknown) => updateBuilder(table),
  execute: async () => {
    // O driver neon-http não oferece db.transaction. Este mock só expõe
    // execute para a confirmação: se a implementação voltar a abrir uma
    // transação, a confirmação falha exatamente como falhava na Vercel.
    if (phase === 'happy-confirm') {
      confirmationExecuteCalls++
      // Cada POST recarrega o preview antes de executar o claim SQL.
      if (confirmationExecuteCalls % 2 === 1) return [previewRow]
      confirmationAttempts++
      if (confirmationAttempts === 1) {
        queuedJobs = 1
        return [{
          batch_count: 1,
          eligible_job_count: 1,
          non_template_count: 0,
          preview_matches: true,
          reserved_count: 0,
          jobs_created: 1,
        }]
      }
      return [{
        batch_count: 0,
        eligible_job_count: 0,
        non_template_count: 0,
        preview_matches: false,
        reserved_count: 1,
        jobs_created: 0,
      }]
    }
    return phase === 'empty-preview' ? [] : [previewRow]
  },
  transaction: async (callback: (tx: any) => Promise<unknown>) => {
    if (phase === 'cron') {
      const tx = {
        update: (table: unknown) => updateBuilder(table),
        select: () => {
          const value = builder(() => [{
            job: queuedJob,
            companyId: company.id,
            metaPhoneNumberId: settingsRow.metaPhoneNumberId,
            availabilitySchedule: null,
            availabilityScheduleManual: false,
            nativeAvailabilitySchedule: null,
            leadPhone: validLead.phone,
            leadCreatedAt: validLead.createdAt,
            leadPriority: 0,
            checkBeforeSend: true,
          }])
          return value
        },
      }
      return callback(tx)
    }

    throw new Error(`transação inesperada na fase ${phase}`)
  },
}

mock.module('@/lib/db', { namedExports: { db: fakeDb } })
mock.module('@/lib/auth', { namedExports: { requireCompany: async () => company } })
mock.module('@/lib/whatsapp/meta', {
  namedExports: {
    listMetaTemplates: async () => [{
      name: previewRow.template_name,
      status: 'APPROVED',
      language: 'pt_BR',
      category: 'MARKETING',
      components: [],
    }],
  },
})
mock.module('@/lib/whatsapp', {
  namedExports: {
    sendWhatsAppMessage: async (phone: string, message: unknown) => {
      sendCalls++
      assert.equal(phone, validLead.phone)
      assert.deepEqual(message, {
        type: 'template',
        content: 'Olá Lead Duplicado',
        mediaUrl: undefined,
        caption: '',
        buttons: undefined,
        templateName: 'campanha_aprovada',
        templateLanguage: 'pt_BR',
        templateVariableValues: ['Lead Duplicado'],
        templateVariableNames: undefined,
      })
      return 'wamid.mock.mass-dispatch'
    },
  },
})
mock.module('@/lib/leads', { namedExports: { markLeadContacted: async () => undefined } })
mock.module('@/lib/cron-advisory-lock', {
  namedExports: {
    tryAcquireCronDispatchLock: async () => ({ mockLock: true }),
    releaseCronDispatchLock: async () => { releasedLocks++ },
  },
})

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function main() {
  const originalFetch = globalThis.fetch
  const originalCronSecret = process.env.CRON_SECRET
  globalThis.fetch = (async () => {
    throw new Error('rede externa proibida no teste de disparo em massa')
  }) as typeof fetch
  process.env.CRON_SECRET = 'cron-secret-test'

  const { POST: importLeads } = await import('../src/app/api/leads/import/route')
  const { GET: getDispatchPreview, POST: confirmDispatch } = await import('../src/app/api/leads/import/[batchId]/dispatch/route')
  const { POST: runCron } = await import('../src/app/api/cron/route')

  try {
    await test('lote sem itens é rejeitado antes de criar draft ou enviar', async () => {
      phase = 'idle'
      const response = await importLeads(jsonRequest('https://sac.test/api/leads/import', {
        items: [],
        createMassDispatch: true,
      }) as any)

      assert.equal(response.status, 400)
      assert.match((await response.json()).error, /Nenhum contato/)
      assert.equal(sendCalls, 0)
    })

    await test('telefone inválido gera draft vazio, que não pode ser confirmado', async () => {
      phase = 'import-invalid'
      const imported = await importLeads(jsonRequest('https://sac.test/api/leads/import', {
        items: [{ phone: 'sem telefone', name: 'Inválido' }],
        fileName: 'invalido.csv',
        createMassDispatch: true,
        defaultEventType: 'carrinho_abandonado',
      }) as any)
      const result = await imported.json()

      assert.equal(imported.status, 200)
      assert.equal(result.skipped, 1)
      assert.equal(result.recipientCount, 0)
      assert.match(result.errors[0], /Telefone inválido/)

      phase = 'empty-preview'
      const rejected = await confirmDispatch(jsonRequest('https://sac.test/api/leads/import/2/dispatch', {
        confirm: true,
        previewMessages: [],
      }) as any, { params: Promise.resolve({ batchId: '2' }) })

      assert.equal(rejected.status, 409)
      assert.match((await rejected.json()).error, /não tem destinatários válidos/)
      assert.equal(queuedJobs, 0)
      assert.equal(sendCalls, 0)
    })

    await test('fluxo completo deduplica telefone, exige confirmação, enfileira e usa sender mockado', async () => {
      phase = 'import-happy'
      recoverySelectCount = 0
      confirmationAttempts = 0
      confirmationExecuteCalls = 0
      queuedJobs = 0
      recipientLeadIds.clear()
      const imported = await importLeads(jsonRequest('https://sac.test/api/leads/import', {
        items: [
          { phone: '11 99999-0001', name: 'Lead Original' },
          { phone: '+55 (11) 99999-0001', name: 'Lead Duplicado' },
          { phone: 'abc', name: 'Sem telefone válido' },
        ],
        fileName: 'leads.csv',
        createMassDispatch: true,
        defaultEventType: 'carrinho_abandonado',
      }) as any)
      const importResult = await imported.json()

      assert.equal(imported.status, 200)
      assert.equal(importResult.batchStatus, 'draft')
      assert.equal(importResult.inserted, 1)
      assert.equal(importResult.updated, 1)
      assert.equal(importResult.skipped, 1)
      assert.equal(importResult.recipientCount, 1)
      assert.equal(recipientLeadIds.size, 1)
      assert.equal(sendCalls, 0)

      phase = 'happy-preview'
      const previewResponse = await getDispatchPreview(new Request('https://sac.test/api/leads/import/1/dispatch') as any, {
        params: Promise.resolve({ batchId: '1' }),
      })
      const preview = await previewResponse.json()
      assert.equal(previewResponse.status, 200)
      assert.equal(preview.recipientCount, 1)
      assert.equal(preview.totalJobs, 1)

      const missingConfirmation = await confirmDispatch(jsonRequest('https://sac.test/api/leads/import/1/dispatch', {
        previewMessages: preview.messages,
      }) as any, { params: Promise.resolve({ batchId: '1' }) })
      assert.equal(missingConfirmation.status, 400)
      assert.match((await missingConfirmation.json()).error, /Confirmação explícita obrigatória/)
      assert.equal(queuedJobs, 0)

      phase = 'happy-confirm'
      const confirmed = await confirmDispatch(jsonRequest('https://sac.test/api/leads/import/1/dispatch', {
        confirm: true,
        previewMessages: preview.messages,
      }) as any, { params: Promise.resolve({ batchId: '1' }) })
      assert.equal(confirmed.status, 200)
      assert.deepEqual(await confirmed.json(), {
        success: true,
        batchId: 1,
        status: 'queued',
        jobsCreated: 1,
      })
      assert.equal(queuedJobs, 1)
      assert.equal(sendCalls, 0, 'confirmar só enfileira; não chama o provedor')

      const confirmedAgain = await confirmDispatch(jsonRequest('https://sac.test/api/leads/import/1/dispatch', {
        confirm: true,
        previewMessages: preview.messages,
      }) as any, { params: Promise.resolve({ batchId: '1' }) })
      assert.equal(confirmedAgain.status, 409)
      assert.match((await confirmedAgain.json()).error, /confirmado por outra requisição/)
      assert.equal(confirmationAttempts, 2)
      assert.equal(queuedJobs, 1, 'dupla confirmação não cria um segundo job')

      phase = 'cron'
      recoverySelectCount = 0
      messageJobSelectCount = 0
      const cronResponse = await runCron(new Request('https://sac.test/api/cron', {
        method: 'POST',
        headers: { Authorization: 'Bearer cron-secret-test' },
      }) as any)

      assert.equal(cronResponse.status, 200)
      assert.deepEqual(await cronResponse.json(), { processed: 1, sent: 1, failed: 0 })
      assert.equal(sendCalls, 1)
      assert.equal(releasedLocks, 1)
      assert.ok(jobUpdates.some(update => update.status === 'sent'))
    })
  } finally {
    globalThis.fetch = originalFetch
    if (originalCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = originalCronSecret
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
