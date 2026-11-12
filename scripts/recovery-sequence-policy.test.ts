import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canScheduleAutomaticRecoverySequence,
  buildIsabelaBoletoIdempotencyKey,
  buildIsabelaFlowIdempotencyKey,
  hasExplicitWhatsAppConsent,
  isConfiguredIsabelaFlow,
  isApprovedImmediateIsabelaBoletoSequence,
  isApprovedIsabelaSequence,
  isApprovedUtilitySequence,
  isWhatsAppOptOutText,
  isConsentExemptKiwifyEventJob,
  ISABELA_FLOW_TEMPLATE_NAMES,
  ISABELA_APPROVED_TEMPLATE_NAMES,
} from '../src/lib/recovery-sequence-policy'

test('carrinho abandonado registra estado, mas nunca agenda mensagem', () => {
  assert.equal(canScheduleAutomaticRecoverySequence('carrinho_abandonado'), false)
  assert.equal(canScheduleAutomaticRecoverySequence('boleto'), true)
  assert.equal(canScheduleAutomaticRecoverySequence('pix'), true)
  assert.equal(canScheduleAutomaticRecoverySequence('cartao_recusado'), true)
})

test('sequência da Isabela exige mensagem template com nome UTILITY aprovado', () => {
  const approved = new Set(['status_atendimento'])
  assert.equal(isApprovedUtilitySequence([{ messageType: 'template', templateName: 'status_atendimento' }], approved), true)
  assert.equal(isApprovedUtilitySequence([{ messageType: 'text', templateName: null }], approved), false)
  assert.equal(isApprovedUtilitySequence([{ messageType: 'template', templateName: 'coringa_texto' }], approved), false)
  assert.equal(isApprovedUtilitySequence([], approved), false)
})

test('sequência da Isabela aceita somente os nomes aprovados, incluindo MARKETING, e rejeita coringas', () => {
  const approved = new Set(['boas_vindas_despertar_pos_compra', 'formulario_desafio_d1'])
  assert.equal(isApprovedIsabelaSequence([
    { messageType: 'template', templateName: 'boas_vindas_despertar_pos_compra', templateLanguage: 'pt_BR' },
    { messageType: 'template', templateName: 'formulario_desafio_d1', templateLanguage: 'pt_BR' },
  ], approved), true)
  assert.equal(isApprovedIsabelaSequence([{ messageType: 'template', templateName: 'coringa_texto', templateLanguage: 'pt_BR' }], new Set(['coringa_texto'])), false)
  assert.equal(isApprovedIsabelaSequence([{ messageType: 'text', templateName: null }], approved), false)
})

test('boleto do Despertar exige uma única mensagem UTILITY imediata com referência e vencimento', () => {
  const approved = new Set(['boleto_despertar_nao_pago'])
  const message = {
    messageType: 'template',
    templateName: 'boleto_despertar_nao_pago',
    templateLanguage: 'pt_BR',
    delayMinutes: 0,
    templateVariablesMap: { '1': '{boleto_codigo}', '2': '{boleto_validade}' },
  }

  assert.equal(isApprovedImmediateIsabelaBoletoSequence([message], approved), true)
  assert.equal(isApprovedImmediateIsabelaBoletoSequence([{ ...message, delayMinutes: 30 }], approved), false)
  assert.equal(isApprovedImmediateIsabelaBoletoSequence([message, message], approved), false)
  assert.equal(isApprovedImmediateIsabelaBoletoSequence([{ ...message, templateVariablesMap: { '1': '{nome}' } }], approved), false)
})

test('consentimento de WhatsApp precisa ser explícito', () => {
  assert.equal(hasExplicitWhatsAppConsent({ Customer: { whatsapp_opt_in: true } }), true)
  assert.equal(hasExplicitWhatsAppConsent({ data: { buyer: { whatsapp_opt_in: 'sim' } } }), true)
  assert.equal(hasExplicitWhatsAppConsent({ whatsapp_consent: 'sim' }), true)
  assert.equal(hasExplicitWhatsAppConsent({ Customer: { mobile: '+5565999999999' } }), false)
  assert.equal(hasExplicitWhatsAppConsent({ accepted_terms: true }), false)
  assert.equal(buildIsabelaBoletoIdempotencyKey(2, 'pedido-1'), 'boleto_followup_immediate:2:pedido-1')
})

test('boleto imediato aceita parâmetros nomeados reais', () => {
  const approved = new Set(['boleto_despertar_nao_pago'])
  const message = {
    messageType: 'template', templateName: 'boleto_despertar_nao_pago', templateLanguage: 'pt_BR', delayMinutes: 0,
    templateVariablesMap: { customer_name: '{nome}', order_reference: '{transacao}', payment_due_date: '{boleto_validade}' },
  }
  assert.equal(isApprovedImmediateIsabelaBoletoSequence([message], approved), true)
  assert.equal(isApprovedImmediateIsabelaBoletoSequence([{ ...message, templateVariablesMap: { '1': '{nome}', '2': '{boleto_validade}' } }], approved), false)
  assert.equal(isApprovedImmediateIsabelaBoletoSequence([{ ...message, delayMinutes: 30 }], approved), false)
  assert.equal(hasExplicitWhatsAppConsent({ Customer: { whatsapp_opt_in: false } }), false)
})

test('cada fluxo da Isabela exige o catálogo exato de templates aprovados', () => {
  const approved = new Map([
    ['boas_vindas_despertar_pos_compra', { name: 'boas_vindas_despertar_pos_compra', category: 'UTILITY', language: 'pt_BR' }],
    ['formulario_desafio_d1', { name: 'formulario_desafio_d1', category: 'MARKETING', language: 'pt_BR' }],
    ['acompanhamento_desafio_d10', { name: 'acompanhamento_desafio_d10', category: 'MARKETING', language: 'pt_BR' }],
    ['cartao_despertar_recusado', { name: 'cartao_despertar_recusado', category: 'UTILITY', language: 'pt_BR' }],
  ])
  const named = { customer_name: '{nome}' }
  const purchase = [
    { order: 1, messageType: 'template', templateName: 'boas_vindas_despertar_pos_compra', templateLanguage: 'pt_BR', templateVariablesMap: named },
    { order: 2, messageType: 'template', templateName: 'formulario_desafio_d1', templateLanguage: 'pt_BR', templateVariablesMap: named },
    { order: 3, messageType: 'template', templateName: 'acompanhamento_desafio_d10', templateLanguage: 'pt_BR', templateVariablesMap: named },
  ]
  assert.equal(isConfiguredIsabelaFlow(purchase, 'compra_aprovada', approved), true)
  assert.equal(isConfiguredIsabelaFlow([{ ...purchase[0], templateName: 'coringa_texto' }], 'compra_aprovada', approved), false)
  assert.equal(isConfiguredIsabelaFlow([purchase[0]], 'compra_aprovada', approved), false)
  assert.equal(isConfiguredIsabelaFlow([{
    order: 1, messageType: 'template', templateName: 'cartao_despertar_recusado', templateLanguage: 'pt_BR',
  }], 'cartao_recusado', approved), true)
  assert.equal(buildIsabelaFlowIdempotencyKey('cartao_recusado', 2, 'pedido-1', 9), 'isabela:cartao_recusado:2:pedido-1:9')
})

test('opt-out reconhece comandos explícitos sem inferir a partir de texto comum', () => {
  assert.equal(isWhatsAppOptOutText('PARE de mandar mensagens'), true)
  assert.equal(isWhatsAppOptOutText('STOP'), true)
  assert.equal(isWhatsAppOptOutText('optout'), true)
  assert.equal(isWhatsAppOptOutText('Quero continuar'), false)
  assert.equal(isWhatsAppOptOutText('não comecei ainda'), false)
})

test('compra aprovada exige os templates NOMEADOS com customer_name; coringa v2 e *_20261031 ficam de fora', () => {
  const approved = new Map([
    ['boas_vindas_despertar_pos_compra', { name: 'boas_vindas_despertar_pos_compra', category: 'MARKETING', language: 'pt_BR' }],
    ['formulario_desafio_d1', { name: 'formulario_desafio_d1', category: 'MARKETING', language: 'pt_BR' }],
    ['acompanhamento_desafio_d10', { name: 'acompanhamento_desafio_d10', category: 'UTILITY', language: 'pt_BR' }],
  ])
  const build = (map: unknown) => ['boas_vindas_despertar_pos_compra', 'formulario_desafio_d1', 'acompanhamento_desafio_d10'].map((templateName, i) => (
    { order: i + 1, messageType: 'template', templateName, templateLanguage: 'pt_BR', templateVariablesMap: map }
  ))
  assert.deepEqual(ISABELA_FLOW_TEMPLATE_NAMES.compra_aprovada, ['boas_vindas_despertar_pos_compra', 'formulario_desafio_d1', 'acompanhamento_desafio_d10'])
  assert.equal(isConfiguredIsabelaFlow(build({ customer_name: '{nome}' }), 'compra_aprovada', approved), true)
  assert.equal(isConfiguredIsabelaFlow(build({ customer_name: '{primeiro_nome}' }), 'compra_aprovada', approved), true)
  // sem mapa, mapa posicional ou parâmetro com outro nome: a Meta recusaria (template NAMED)
  assert.equal(isConfiguredIsabelaFlow(build(null), 'compra_aprovada', approved), false)
  assert.equal(isConfiguredIsabelaFlow(build({ '1': '{nome}' }), 'compra_aprovada', approved), false)
  assert.equal(isConfiguredIsabelaFlow(build({ nome: '{nome}' }), 'compra_aprovada', approved), false)
  assert.equal(isConfiguredIsabelaFlow(build({ customer_name: '{email}' }), 'compra_aprovada', approved), false)
  // coringa v2 (variáveis {bloco_1..4}) e o template com "[nome ]" literal não passam no fluxo
  const coringa = [{ order: 1, messageType: 'template', templateName: 'coringa_bela_contexto_atendimento_v2', templateLanguage: 'pt_BR', templateVariablesMap: { bloco_1: 'x' } }]
  assert.equal(isConfiguredIsabelaFlow(coringa, 'compra_aprovada', approved), false)
  const velho = build({ customer_name: '{nome}' }).map((m, i) => i === 1 ? { ...m, templateName: 'isabela_formulario_d1_20261031_corrigida' } : m)
  assert.equal(isConfiguredIsabelaFlow(velho, 'compra_aprovada', new Map([...approved, ['isabela_formulario_d1_20261031_corrigida', { name: 'isabela_formulario_d1_20261031_corrigida', category: 'MARKETING', language: 'pt_BR' }]])), false)
  assert.equal(ISABELA_APPROVED_TEMPLATE_NAMES.includes('coringa_bela_contexto_atendimento_v2' as never), false)
  assert.equal(ISABELA_APPROVED_TEMPLATE_NAMES.some(name => name.includes('_20261031')), false)
})

test('isenção de opt_in: só os quatro jobTypes de evento da Kiwify; Portal e jobs sem tipo continuam exigindo', () => {
  for (const type of ['isabela_purchase_sequence', 'boleto_followup_immediate', 'isabela_cartao_recusado', 'pix_followup_60m']) {
    assert.equal(isConsentExemptKiwifyEventJob(type), true, type)
  }
  for (const type of ['isabela_portal_after_challenge', 'follow_up_ia', 'upsell', '', null, undefined]) {
    assert.equal(isConsentExemptKiwifyEventJob(type as string | null | undefined), false, String(type))
  }
})
