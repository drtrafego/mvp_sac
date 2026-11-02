import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canScheduleAutomaticRecoverySequence,
  buildIsabelaBoletoIdempotencyKey,
  hasExplicitWhatsAppConsent,
  isApprovedImmediateIsabelaBoletoSequence,
  isApprovedUtilitySequence,
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
