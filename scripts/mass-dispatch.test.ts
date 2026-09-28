import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildMassDispatchPreview, executeAndRecordDispatch, type DispatchOutcome } from '../src/lib/mass-dispatch'
import { MAX_JOBS_PER_RUN, estimateMaxMessagesPerHour } from '../src/lib/message-jobs-policy'

test('preview informa destinatários, mensagens ordenadas e total exato de jobs', () => {
  const preview = buildMassDispatchPreview({
    batchId: 42,
    status: 'draft',
    recipientCount: 3,
    eventType: 'carrinho_abandonado',
    messages: [
      { id: 2, order: 2, delayMinutes: 60, messageType: 'text', content: 'Lembrete', templateName: null },
      { id: 1, order: 1, delayMinutes: 0, messageType: 'template', content: 'Olá {nome}', templateName: 'boas_vindas' },
    ],
  })

  assert.equal(preview.recipientCount, 3)
  assert.equal(preview.messageCount, 2)
  assert.equal(preview.totalJobs, 6)
  assert.deepEqual(preview.messages.map(message => message.id), [1, 2])
  assert.equal(preview.messages[0].content, 'Olá {nome}')
})

test('executor registra sucesso e falha separadamente por lead sem chamada real', async () => {
  const records = new Map<number, DispatchOutcome>()
  const fakePhones = ['5500000000001', '5500000000002']

  for (const [index, fakePhone] of fakePhones.entries()) {
    const leadId = index + 1
    await executeAndRecordDispatch(
      async () => {
        // Remetente 100% fake: nenhuma API/rede é chamada por este teste.
        if (fakePhone.endsWith('2')) throw new Error('Meta 429 mockado')
        return `wamid.fake.${leadId}`
      },
      async outcome => { records.set(leadId, outcome) },
      () => new Date('2026-09-28T12:00:00.000Z'),
    )
  }

  assert.deepEqual(records.get(1), {
    status: 'sent',
    externalWamid: 'wamid.fake.1',
    sentAt: new Date('2026-09-28T12:00:00.000Z'),
  })
  assert.deepEqual(records.get(2), { status: 'failed', error: 'Meta 429 mockado' })
})

test('limite do executor permanece conservador', () => {
  assert.equal(MAX_JOBS_PER_RUN, 50)
  assert.equal(estimateMaxMessagesPerHour(), 600)
})

test('upload de CSV sozinho nunca envia nem cria message_jobs', () => {
  const importSource = readFileSync(resolve(process.cwd(), 'src/app/api/leads/import/route.ts'), 'utf8')
  assert.doesNotMatch(importSource, /sendWhatsAppMessage|sendMetaText|graph\.facebook\.com/)
  assert.doesNotMatch(importSource, /insert\(messageJobs\)/)
  assert.match(importSource, /status:\s*'draft'/)
  assert.match(importSource, /massDispatchRecipients/)
})

test('rota de disparo exige confirmação explícita e faz claim atômico', () => {
  const routeSource = readFileSync(resolve(process.cwd(), 'src/app/api/leads/import/[batchId]/dispatch/route.ts'), 'utf8')
  const executorSource = readFileSync(resolve(process.cwd(), 'src/lib/mass-dispatch.ts'), 'utf8')
  assert.match(routeSource, /body\.confirm !== true/)
  assert.match(executorSource, /WITH eligible_messages AS/)
  assert.match(executorSource, /UPDATE mass_dispatch_batches/)
  assert.match(executorSource, /INSERT INTO message_jobs/)
  assert.match(executorSource, /b\.status = 'draft'/)
})
