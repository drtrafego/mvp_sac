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
  const approved = new Set(['boas_vindas_despertar_pos_compra', 'isabela_formulario_d1_20261031_corrigida'])
  assert.equal(isApprovedIsabelaSequence([
    { messageType: 'template', templateName: 'boas_vindas_despertar_pos_compra', templateLanguage: 'pt_BR' },
    { messageType: 'template', templateName: 'isabela_formulario_d1_20261031_corrigida', templateLanguage: 'pt_BR' },
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
    ['isabela_formulario_d1_20261031_corrigida', { name: 'isabela_formulario_d1_20261031_corrigida', category: 'MARKETING', language: 'pt_BR' }],
    ['acompanhamento_desafio_d10', { name: 'acompanhamento_desafio_d10', category: 'MARKETING', language: 'pt_BR' }],
    ['cartao_despertar_recusado', { name: 'cartao_despertar_recusado', category: 'UTILITY', language: 'pt_BR' }],
  ])
  const purchase = [
    { order: 1, messageType: 'template', templateName: 'boas_vindas_despertar_pos_compra', templateLanguage: 'pt_BR' },
    { order: 2, messageType: 'template', templateName: 'isabela_formulario_d1_20261031_corrigida', templateLanguage: 'pt_BR' },
    { order: 3, messageType: 'template', templateName: 'acompanhamento_desafio_d10', templateLanguage: 'pt_BR' },
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
  assert.equal(isWhatsAppOptOutText('Quero continuar'), false)
  assert.equal(isWhatsAppOptOutText('não comecei ainda'), false)
})
