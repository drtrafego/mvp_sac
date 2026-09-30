import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  loadApprovedMetaTemplates,
  normalizeWhatsappProvider,
  toApprovedMetaTemplate,
} from '../src/lib/meta-templates'
import type { MetaTemplate } from '../src/lib/whatsapp/meta'

function tpl(name: string, status: string, language = 'pt_BR'): MetaTemplate {
  return {
    name,
    status,
    language,
    category: 'UTILITY',
    components: [
      { type: 'HEADER', text: 'Titulo' },
      { type: 'BODY', text: 'Oi {{1}}, seu pedido {{2}} foi aprovado.' },
    ],
  }
}

test('provider vazio ou nulo mantém compatibilidade com empresas antigas e assume Meta', () => {
  assert.equal(normalizeWhatsappProvider(null), 'meta')
  assert.equal(normalizeWhatsappProvider(''), 'meta')
  assert.equal(normalizeWhatsappProvider('uazapi'), 'uazapi')
})

test('templates APPROVED viram cards reais e status diferente não aparece', () => {
  const approved = toApprovedMetaTemplate(tpl('compra_aprovada', 'APPROVED'))
  assert.ok(approved)
  assert.equal(approved.nome, 'compra_aprovada')
  assert.equal(approved.idioma, 'pt_BR')
  assert.deepEqual(approved.variaveis, ['variavel_1', 'variavel_2'])

  assert.equal(toApprovedMetaTemplate(tpl('pendente', 'PENDING')), null)
  assert.equal(toApprovedMetaTemplate(tpl('rejeitado', 'REJECTED')), null)
})

test('busca usa somente WABA/token da empresa atual e não mistura clientes', async () => {
  const calls: Array<{ wabaId: string; accessToken: string }> = []
  const fetcher = async (wabaId: string, accessToken: string): Promise<MetaTemplate[]> => {
    calls.push({ wabaId, accessToken })
    return [tpl(`template_${wabaId}`, 'APPROVED')]
  }

  const companyA = await loadApprovedMetaTemplates({
    whatsappProvider: null,
    metaWabaId: 'waba_a',
    metaAccessToken: 'token_a',
  }, fetcher)
  const companyB = await loadApprovedMetaTemplates({
    whatsappProvider: 'meta',
    metaWabaId: 'waba_b',
    metaAccessToken: 'token_b',
  }, fetcher)

  assert.equal(companyA.kind, 'ready')
  assert.equal(companyA.templates[0].nome, 'template_waba_a')
  assert.equal(companyB.kind, 'ready')
  assert.equal(companyB.templates[0].nome, 'template_waba_b')
  assert.deepEqual(calls, [
    { wabaId: 'waba_a', accessToken: 'token_a' },
    { wabaId: 'waba_b', accessToken: 'token_b' },
  ])
})

test('estado vazio, configuração ausente e erro da Meta ficam distinguíveis', async () => {
  const missing = await loadApprovedMetaTemplates({ whatsappProvider: 'meta', metaWabaId: 'waba_sem_token' })
  assert.equal(missing.kind, 'missing_config')
  assert.match(missing.message, /WABA ID e o Access Token/)

  const empty = await loadApprovedMetaTemplates({
    whatsappProvider: 'meta',
    metaWabaId: 'waba_vazia',
    metaAccessToken: 'token_vazio',
  }, async () => [])
  assert.equal(empty.kind, 'empty')
  assert.match(empty.message, /sem templates APPROVED/)

  const error = await loadApprovedMetaTemplates({
    whatsappProvider: 'meta',
    metaWabaId: 'waba_erro',
    metaAccessToken: 'token_secreto',
  }, async () => {
    throw new Error('Meta API erro 401 token_secreto')
  })
  assert.equal(error.kind, 'error')
  assert.equal(error.message.includes('token_secreto'), false)
  assert.match(error.message, /token-redigido/)
})
