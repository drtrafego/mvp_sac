// Teste de hashing e montagem de payload da Meta Conversions API
// (src/lib/meta-conversions-api.ts). Não precisa de token real nem de banco:
// confere que o SHA-256 bate com o algoritmo oficial documentado pela própria
// Meta (lowercase+trim pra e-mail, E.164 sem "+" pra telefone) e que o
// payload final tem o formato exato que a Graph API espera.
//
// Uso: npx tsx scripts/meta-conversions-api.test.ts

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  buildCapiPayload,
  hashEmail,
  hashPhone,
  purchaseEventId,
  scheduleEventId,
} from '../src/lib/meta-conversions-api'

function refSha256(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

// ─── hashEmail: lowercase + trim antes de hashear ──────────────────────────
assert.equal(hashEmail('Cliente@Exemplo.com'), refSha256('cliente@exemplo.com'))
assert.equal(hashEmail('  cliente@exemplo.com  '), refSha256('cliente@exemplo.com'))
assert.equal(hashEmail(''), null)
assert.equal(hashEmail(null), null)
assert.equal(hashEmail(undefined), null)

// ─── hashPhone: E.164 sem símbolos antes de hashear ────────────────────────
// recoveryLeads.phone já chega assim de formatBrazilianPhone(): só dígitos, com DDI.
assert.equal(hashPhone('5511999998888'), refSha256('5511999998888'))
// Defensivo: remove "+", espaço e traço residual, nunca reformata DDI.
assert.equal(hashPhone('+55 11 99999-8888'), refSha256('5511999998888'))
assert.equal(hashPhone(''), null)
assert.equal(hashPhone(null), null)

// ─── event_id determinístico e reproduzível ────────────────────────────────
assert.equal(purchaseEventId('HP123456'), 'purchase_HP123456')
assert.equal(purchaseEventId('HP123456'), purchaseEventId('HP123456')) // reenviar = mesmo id
assert.equal(scheduleEventId(7, 42, new Date('2026-09-21T18:00:00Z')), `schedule_7_42_${new Date('2026-09-21T18:00:00Z').getTime()}`)

// ─── buildCapiPayload: formato exato esperado pela Graph API ───────────────
const eventTime = new Date('2026-09-21T18:00:00Z')
const payloadCompleto = buildCapiPayload({
  eventName: 'Purchase',
  eventId: 'purchase_HP123456',
  eventTime,
  phone: '5511999998888',
  email: 'Cliente@Exemplo.com',
  name: 'José da Silva',
  city: 'São Paulo',
  state: 'SP',
  country: 'BR',
  zipcode: '01310-100',
  externalId: '123.456.789-09',
  rawPayload: { Customer: { ip: '203.0.113.10' }, fbp: 'fb.1.123.456', fbc: 'fb.1.123.click' },
  productId: 'prod_123',
  productName: 'Curso teste',
  transactionId: 'HP123456',
  value: 197.0,
  currency: 'BRL',
})

assert.equal(payloadCompleto.data.length, 1)
const evento = payloadCompleto.data[0]
assert.equal(evento.event_name, 'Purchase')
assert.equal(evento.event_id, 'purchase_HP123456')
assert.equal(evento.action_source, 'system_generated')
assert.equal(evento.event_time, Math.floor(eventTime.getTime() / 1000))
assert.deepEqual(evento.user_data.ph, [refSha256('5511999998888')])
assert.deepEqual(evento.user_data.em, [refSha256('cliente@exemplo.com')])
assert.deepEqual(evento.user_data.fn, [refSha256('jose')])
assert.deepEqual(evento.user_data.ln, [refSha256('da silva')])
assert.deepEqual(evento.user_data.ct, [refSha256('sao paulo')])
assert.deepEqual(evento.user_data.st, [refSha256('sp')])
assert.deepEqual(evento.user_data.zp, [refSha256('01310100')])
assert.deepEqual(evento.user_data.country, [refSha256('br')])
assert.deepEqual(evento.user_data.external_id, [refSha256('12345678909')])
assert.equal(evento.user_data.fbp, 'fb.1.123.456')
assert.equal(evento.user_data.fbc, 'fb.1.123.click')
assert.equal(evento.user_data.client_ip_address, '203.0.113.10')
assert.deepEqual(evento.custom_data, {
  value: 197.0,
  currency: 'BRL',
  order_id: 'HP123456',
  content_ids: ['prod_123'],
  content_name: 'Curso teste',
  content_type: 'product',
})

// Nunca telefone/e-mail em texto plano em lugar nenhum do payload serializado.
const serializado = JSON.stringify(payloadCompleto)
assert.ok(!serializado.includes('5511999998888'))
assert.ok(!serializado.includes('cliente@exemplo.com'))
assert.ok(!serializado.includes('12345678909'))
assert.ok(!serializado.includes('jose'))
assert.ok(!serializado.includes('Cliente@Exemplo.com'))

// Sem valor (reserva/agendamento sem transação financeira, ex.: Gramado): sem custom_data.
const payloadSemValor = buildCapiPayload({
  eventName: 'Schedule',
  eventId: 'schedule_7_42_1758473000000',
  eventTime,
  phone: '5511999998888',
  email: null,
})
assert.equal(payloadSemValor.data[0].custom_data, undefined)
assert.deepEqual(payloadSemValor.data[0].user_data, { ph: [refSha256('5511999998888')] })
assert.equal('em' in payloadSemValor.data[0].user_data, false)

// Sem telefone nem e-mail: user_data vazio (sendConversionEvent rejeita esse
// caso antes de chamar a Graph API, mas buildCapiPayload em si é uma função
// pura e não deve lançar).
const payloadVazio = buildCapiPayload({
  eventName: 'Purchase',
  eventId: 'purchase_sem_contato',
  eventTime,
})
assert.deepEqual(payloadVazio.data[0].user_data, {})

console.log('OK: meta-conversions-api hashing e payload batem com o algoritmo oficial da Meta.')
