import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPixFollowupIdempotencyKey,
  isApprovedUtilityPixTemplate,
  isRealPendingPix,
  PIX_FOLLOWUP_DELAY_MINUTES,
  PIX_FOLLOWUP_TEMPLATE_NAME,
  validatePixFollowupMessage,
} from '@/lib/pix-followup-policy'

const baseLead = {
  eventType: 'pix',
  paymentType: 'pix',
  phone: 'phone-real',
  transactionId: 'pedido-interno-1',
  pixCode: 'pix-copia-e-cola-real',
  pixExpiry: new Date('2026-11-02T20:00:00.000Z'),
  status: 'pending',
  approvedDate: null,
  botPaused: false,
  whatsappConsentStatus: 'opted_in',
}

test('Pix real pendente só passa com código, validade e consentimento explícito', () => {
  assert.deepEqual(isRealPendingPix(baseLead), { eligible: true })
  assert.equal(isRealPendingPix({ ...baseLead, whatsappConsentStatus: 'unknown' }).eligible, false)
  assert.equal(isRealPendingPix({ ...baseLead, pixCode: null }).eligible, false)
  assert.equal(isRealPendingPix({ ...baseLead, approvedDate: new Date() }).eligible, false)
})

test('gate do Pix: pausa barra como antes; bypass (lista de permissão) só ignora pausa da chave; atendente e opt-out sempre barram', () => {
  const swPause = { ...baseLead, botPaused: true, botPausedBy: 'Administrador (Agente IA)', botPausedAll: true }
  assert.equal(isRealPendingPix(swPause).eligible, false)
  assert.deepEqual(isRealPendingPix(swPause, { ignoreSwitchPause: true }), { eligible: true })
  assert.deepEqual(isRealPendingPix({ ...baseLead, botPaused: true, botPausedBy: 'auto (pausa geral ativa)' }, { ignoreSwitchPause: true }), { eligible: true })
  assert.equal(isRealPendingPix({ ...baseLead, botPaused: true, botPausedBy: 'Atendente Maria' }, { ignoreSwitchPause: true }).eligible, false)
  assert.equal(isRealPendingPix({ ...swPause, botPausedBy: 'optout_whatsapp' }, { ignoreSwitchPause: true }).eligible, false)
  assert.equal(isRealPendingPix({ ...swPause, botPausedBy: 'revisao_possivel_optout' }, { ignoreSwitchPause: true }).eligible, false)
})

test('configuração exige uma única mensagem template, 60 minutos e dados reais', () => {
  const valid = validatePixFollowupMessage({
    messageType: 'template',
    templateName: PIX_FOLLOWUP_TEMPLATE_NAME,
    templateLanguage: 'pt_BR',
    delayMinutes: PIX_FOLLOWUP_DELAY_MINUTES,
    templateVariablesMap: { '1': '{nome}', '2': '{pix_validade}' },
  })
  assert.deepEqual(valid, { eligible: true })
  assert.equal(validatePixFollowupMessage({
    messageType: 'text',
    templateName: PIX_FOLLOWUP_TEMPLATE_NAME,
    templateLanguage: 'pt_BR',
    delayMinutes: 60,
    templateVariablesMap: { '1': '{nome}', '2': '{pix_validade}' },
  }).eligible, false)
  assert.equal(validatePixFollowupMessage({
    messageType: 'template',
    templateName: PIX_FOLLOWUP_TEMPLATE_NAME,
    templateLanguage: 'pt_BR',
    delayMinutes: 30,
    templateVariablesMap: { '1': '{nome}', '2': '{pix_validade}' },
  }).eligible, false)
})

test('template aprovado precisa ser UTILITY e a chave é estável por pedido', () => {
  assert.equal(isApprovedUtilityPixTemplate({
    name: PIX_FOLLOWUP_TEMPLATE_NAME,
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'UTILITY',
  }), true)
  assert.equal(isApprovedUtilityPixTemplate({
    name: PIX_FOLLOWUP_TEMPLATE_NAME,
    language: 'pt_BR',
    status: 'APPROVED',
    category: 'MARKETING',
  }), false)
  assert.equal(buildPixFollowupIdempotencyKey(292, 'pedido-interno-1'), 'pix_followup_60m:292:pedido-interno-1')
})

test('Pix da Isabela dispensa opt_in só quando quem chama prova a lista de permissão; opt-out e pausa de atendente seguem barrando', () => {
  const unknown = { ...baseLead, whatsappConsentStatus: 'unknown' }
  assert.equal(isRealPendingPix(unknown).eligible, false, 'sem a prova: gate de antes')
  assert.deepEqual(isRealPendingPix(unknown, { consentNotRequired: true }), { eligible: true })
  assert.equal(isRealPendingPix({ ...baseLead, whatsappConsentStatus: 'opted_out' }, { consentNotRequired: true }).eligible, false)
  assert.equal(isRealPendingPix({ ...unknown, botPaused: true, botPausedBy: 'Atendente Maria' }, { consentNotRequired: true, ignoreSwitchPause: true }).eligible, false)
  assert.equal(isRealPendingPix({ ...unknown, botPaused: true, botPausedBy: 'optout_whatsapp' }, { consentNotRequired: true, ignoreSwitchPause: true }).eligible, false)
  assert.equal(isRealPendingPix({ ...unknown, pixCode: null }, { consentNotRequired: true }).eligible, false)
})
