import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listAllMetaTemplates, submitMetaTemplate } from '../src/lib/whatsapp/meta'
import { validateMetaTemplateComponents } from '../src/lib/meta-template-validation'

test('submissão usa endpoint WABA oficial com token somente no header', async () => {
  const originalFetch = globalThis.fetch
  let request: Request | undefined
  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { request = new Request(input, init); return new Response(JSON.stringify({ id: 'meta-1', status: 'PENDING' }), { status: 200 }) }) as typeof fetch
    const result = await submitMetaTemplate('waba-test', 'secret-token', { name: 'lembrete_consulta', language: 'pt_BR', category: 'UTILITY', components: [{ type: 'BODY', text: 'Olá {{1}}' }] })
    assert.equal(request?.url, 'https://graph.facebook.com/v19.0/waba-test/message_templates')
    assert.equal(request?.headers.get('authorization'), 'Bearer secret-token')
    assert.equal(result.status, 'PENDING')
  } finally { globalThis.fetch = originalFetch }
})

test('validação estrutural exige BODY único e limita componentes e botões', () => {
  assert.deepEqual(validateMetaTemplateComponents([{ type: 'BODY', text: 'Olá {{1}}' }]), [{ type: 'BODY', text: 'Olá {{1}}' }])
  assert.throws(() => validateMetaTemplateComponents([{ type: 'HEADER', text: 'Cabeçalho' }]), /exatamente um componente BODY/)
  assert.throws(() => validateMetaTemplateComponents([{ type: 'BODY', text: 'ok' }, { type: 'BUTTONS', buttons: Array.from({ length: 4 }, () => ({ type: 'QUICK_REPLY', text: 'Sim' })) }]), /um a três botões/)
})

test('sincronização mantém pendente e motivo de rejeição', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ id: '1', name: 'pendente', status: 'PENDING', language: 'pt_BR', category: 'UTILITY', components: [] }, { id: '2', name: 'rejeitado', status: 'REJECTED', language: 'pt_BR', category: 'MARKETING', components: [], rejected_reason: 'TAG_CONTENT' }] }), { status: 200 })) as typeof fetch
    const templates = await listAllMetaTemplates('waba-test', 'fake-token')
    assert.equal(templates.length, 2)
    assert.equal(templates[1].rejected_reason, 'TAG_CONTENT')
  } finally { globalThis.fetch = originalFetch }
})
