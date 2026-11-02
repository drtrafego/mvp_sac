import assert from 'node:assert/strict'
import test from 'node:test'
import { canScheduleAutomaticRecoverySequence, isApprovedImmediateIsabelaBoletoSequence, isApprovedUtilitySequence, hasExplicitWhatsAppConsent } from '../src/lib/recovery-sequence-policy'

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

test('boleto imediato exige o template aprovado único com parâmetros nomeados reais', () => {
  const approved = new Set(['boleto_despertar_nao_pago'])
  const message = {
    messageType: 'template', templateName: 'boleto_despertar_nao_pago', templateLanguage: 'pt_BR', delayMinutes: 0,
    templateVariablesMap: { customer_name: '{nome}', order_reference: '{transacao}', payment_due_date: '{boleto_validade}' },
  }
  assert.equal(isApprovedImmediateIsabelaBoletoSequence([message], approved), true)
  assert.equal(isApprovedImmediateIsabelaBoletoSequence([{ ...message, templateVariablesMap: { '1': '{nome}', '2': '{boleto_validade}' } }], approved), false)
  assert.equal(isApprovedImmediateIsabelaBoletoSequence([{ ...message, delayMinutes: 30 }], approved), false)
  assert.equal(hasExplicitWhatsAppConsent({ Customer: { whatsapp_opt_in: true } }), true)
  assert.equal(hasExplicitWhatsAppConsent({ Customer: { whatsapp_opt_in: false } }), false)
})
