import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  buildMassDispatchPreview,
  createMessageSnapshot,
  executeAndRecordDispatch,
  isApprovedTemplateOnlySequence,
  type DispatchOutcome,
} from '../src/lib/mass-dispatch'
import { MAX_JOBS_PER_RUN, estimateMaxMessagesPerHour } from '../src/lib/message-jobs-policy'
import { selectRecoverySequence, sequenceMatchesProduct } from '../src/lib/recovery-sequence'
import { MetaRateLimitError, parseRetryAfter } from '../src/lib/whatsapp/meta'

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

test('snapshot da mensagem permanece imutável depois de editar o template original', () => {
  const original = {
    messageType: 'template', content: 'Mensagem A', mediaUrl: null, caption: null,
    buttonsJson: null, templateName: 'campanha_aprovada', templateLanguage: 'pt_BR',
    templateVariablesMap: { '1': '{nome}' },
  }
  const snapshot = createMessageSnapshot(original)
  original.content = 'Mensagem B'
  original.templateVariablesMap['1'] = '{produto}'

  assert.equal(snapshot.content, 'Mensagem A')
  assert.deepEqual(snapshot.templateVariablesMap, { '1': '{nome}' })

  const cronSource = readFileSync(resolve(process.cwd(), 'src/app/api/cron/route.ts'), 'utf8')
  assert.match(cronSource, /job\.messageSnapshot/)
  assert.match(cronSource, /massDispatchBatchId != null/)
})

test('confirmação rejeita sequência que não seja 100% template aprovado', () => {
  assert.equal(isApprovedTemplateOnlySequence([
    { messageType: 'template', templateName: 'aprovado_1' },
    { messageType: 'text', templateName: null },
  ]), false)
  assert.equal(isApprovedTemplateOnlySequence([
    { messageType: 'template', templateName: 'aprovado_1' },
    { messageType: 'template', templateName: 'aprovado_2' },
  ]), true)
  assert.equal(isApprovedTemplateOnlySequence([
    { messageType: 'template', templateName: 'nao_aprovado' },
  ], new Set(['aprovado_1'])), false)

  const routeSource = readFileSync(resolve(process.cwd(), 'src/app/api/leads/import/[batchId]/dispatch/route.ts'), 'utf8')
  assert.match(routeSource, /só é permitido disparo em massa com sequência 100% de template aprovado/)
  assert.match(routeSource, /listMetaTemplates/)
})

test('productFilter usa a mesma regra do webhook e restringe destinatários', () => {
  const sequences = [
    { id: 1, productFilter: null },
    { id: 2, productFilter: 'Produto A' },
  ]
  assert.equal(selectRecoverySequence(sequences, null, 'Produto A')?.id, 2)
  assert.equal(selectRecoverySequence(sequences, null, 'Produto B')?.id, 1)
  assert.equal(sequenceMatchesProduct('Produto A', null, 'Produto A'), true)
  assert.equal(sequenceMatchesProduct('Produto A', null, 'Produto B'), false)

  const queueSource = readFileSync(resolve(process.cwd(), 'src/lib/mass-dispatch.ts'), 'utf8')
  assert.match(queueSource, /candidate\.product_filter = l\.product_id/)
  assert.match(queueSource, /candidate\.product_filter = l\.product_name/)
})

test('falha de persistência após envio aceito vira sent_unconfirmed, nunca failed', async () => {
  const fallbacks: DispatchOutcome[] = []
  const outcome = await executeAndRecordDispatch(
    async () => 'wamid.fake.accepted',
    async () => { throw new Error('banco indisponível') },
    () => new Date('2026-09-28T12:00:00.000Z'),
    async fallback => { fallbacks.push(fallback) },
  )

  assert.equal(outcome.status, 'sent_unconfirmed')
  assert.equal(fallbacks[0]?.status, 'sent_unconfirmed')
  assert.notEqual(outcome.status, 'failed')
})

test('429 respeita Retry-After e usa backoff antes de recolocar na fila', async () => {
  let recorded: DispatchOutcome | undefined
  const outcome = await executeAndRecordDispatch(
    async () => { throw new MetaRateLimitError('Meta 429 mockado', 90_000) },
    async result => { recorded = result },
    () => new Date('2026-09-28T12:00:00.000Z'),
  )
  assert.deepEqual(outcome, {
    status: 'rate_limited',
    retryAt: new Date('2026-09-28T12:01:30.000Z'),
    error: 'Meta 429 mockado',
  })
  assert.deepEqual(recorded, outcome)
  assert.equal(parseRetryAfter('120'), 120_000)
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
  assert.match(executorSource, /WITH target_batch AS/)
  assert.match(executorSource, /eligible_pairs AS/)
  assert.match(executorSource, /UPDATE mass_dispatch_batches/)
  assert.match(executorSource, /INSERT INTO message_jobs/)
  assert.match(executorSource, /b\.status = 'draft'/)
  assert.match(executorSource, /pg_advisory_xact_lock/)
  assert.match(executorSource, /cfg\.meta_phone_number_id/)
  assert.match(executorSource, /message_snapshot/)
  assert.match(executorSource, /preview_matches/)
  assert.match(routeSource, /A sequência mudou depois do preview/)
})
