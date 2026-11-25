import assert from 'node:assert/strict'
import test from 'node:test'
import { canUseSacReply, findApprovedMetaTemplate, readTemplateVariableValues, renderApprovedMetaTemplate } from '../src/lib/composer-policy'
import { createOutboundSender } from '../src/lib/outbound-send'
import { SUPPORTED_VARIABLES, renderTemplateVariableText } from '../src/lib/lead-template-variables'
import { pauseAppliesToJob } from '../src/lib/message-job-class'

const templates = [
  { name: 'janela_aberta', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Olá {{1}}, pedido {{2}}.' }] },
  { name: 'janela_aberta', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello {{1}}.' }] },
  { name: 'rejeitado', language: 'pt_BR', status: 'REJECTED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Não usar {{1}}.' }] },
]

test('composer selects only the exact approved template and language returned for the tenant WABA', () => {
  assert.equal(findApprovedMetaTemplate(templates, 'janela_aberta', 'pt_BR')?.status, 'APPROVED')
  assert.equal(findApprovedMetaTemplate(templates, 'janela_aberta', 'es_AR'), null)
  assert.equal(findApprovedMetaTemplate(templates, 'rejeitado', 'pt_BR'), null)
})

test('template variables are mandatory and render only after every required value is present', () => {
  const components = templates[0].components
  assert.deepEqual(readTemplateVariableValues(components, { '1': 'Gastão' }), { values: ['Gastão', ''], names: [undefined, undefined], missing: ['variavel_2'] })
  const template = templates[0]
  const incomplete = renderApprovedMetaTemplate(template, { '1': 'Gastão' })
  assert.deepEqual(incomplete.missing, ['variavel_2'])
  const complete = renderApprovedMetaTemplate(template, { '1': 'Gastão', '2': '42' })
  assert.deepEqual(complete.missing, [])
  assert.equal(complete.content, 'Olá Gastão, pedido 42.')

  const named = { ...templates[0], components: [{ type: 'BODY', text: 'Olá {{customer_name}}, pedido {{order_reference}}.' }] }
  const namedRendered = renderApprovedMetaTemplate(named, { customer_name: 'Isabella', order_reference: '42' })
  assert.deepEqual(namedRendered.names, ['customer_name', 'order_reference'])
  assert.deepEqual(namedRendered.missing, [])
  assert.equal(namedRendered.content, 'Olá Isabella, pedido 42.')
})

test('conversation mapping keeps the same supported sources as the lead composer', () => {
  assert.deepEqual(
    SUPPORTED_VARIABLES.slice(0, 3).map(variable => variable.label),
    ['Nome completo', 'Primeiro nome', 'E-mail'],
  )
  assert.equal(SUPPORTED_VARIABLES.at(-1)?.label, 'Afiliado')
  assert.equal(renderTemplateVariableText('Olá {{1}}.', { '1': '{primeiro_nome}' }, { name: 'Maria Silva' }), 'Olá Maria.')
  assert.equal(renderTemplateVariableText('Código: {{1}}.', { '1': 'ABC-42' }, { name: 'Maria Silva' }), 'Código: ABC-42.')
})

test('numeric Meta placeholders are sent and previewed in positional order even when the body is shuffled', () => {
  const template = {
    ...templates[0],
    components: [{ type: 'BODY', text: '{{5}} | {{1}} | {{4}} | {{2}} | {{3}}' }],
  }
  const rendered = renderApprovedMetaTemplate(template, { '1': 'um', '2': 'dois', '3': 'três', '4': 'quatro', '5': 'cinco' })
  assert.deepEqual(rendered.values, ['um', 'dois', 'três', 'quatro', 'cinco'])
  assert.equal(rendered.content, 'cinco | um | quatro | dois | três')
  assert.deepEqual(rendered.missing, [])
})

test('a closed WhatsApp window disables SAC free text but leaves approved templates available', () => {
  assert.equal(canUseSacReply('whatsapp', true), false)
  assert.equal(canUseSacReply('whatsapp', false), true)
  assert.equal(canUseSacReply('email', true), true)
})

test('pausing the agent does not block manual or queued message classes', () => {
  assert.equal(pauseAppliesToJob('transactional'), false)
  assert.equal(pauseAppliesToJob('conversational'), false)
  assert.equal(pauseAppliesToJob('promotional'), false)
})

test('template selection reaches the typed transport only on explicit send and never as media', async () => {
  let transportInput: Record<string, unknown> | null = null
  let nextId = 1
  const store = {
    async find() { return undefined },
    async create(values: Record<string, unknown>) { return { ...values, id: nextId++, sendState: 'pending', createdAt: new Date() } as never },
    async claimFailed() { return undefined },
    async finish(_companyId: number, _id: number, values: Record<string, unknown>) { return { ...values, id: 1, sendState: values.sendState, createdAt: new Date() } as never },
    async touchLead() {},
  }
  const send = createOutboundSender({
    store,
    async transport(input) {
      transportInput = input as unknown as Record<string, unknown>
      return { ok: true, externalId: 'test-wamid' }
    },
  })
  const lead = { id: 11, companyId: 7, phone: '5511999999999', channel: 'whatsapp', email: null, productName: null } as never
  const result = await send({ companyId: 7, lead, content: 'Olá Gastão.', messageType: 'template', templateName: 'janela_aberta', templateLanguage: 'pt_BR', templateVariableValues: ['Gastão'] })
  assert.equal(result.ok, true)
  const capturedTransport = transportInput as unknown as Record<string, unknown>
  assert.equal(capturedTransport.messageType, 'template')
  assert.equal(capturedTransport.templateName, 'janela_aberta')

  const mediaResult = await send({ companyId: 7, lead, content: 'preview', mediaUrl: 'https://example.com/a.png', messageType: 'template', templateName: 'janela_aberta' })
  assert.equal(mediaResult.ok, false)
  assert.match(mediaResult.error || '', /mídia/i)
})
