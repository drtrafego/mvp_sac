import assert from 'node:assert/strict'
import { buildGa4CollectUrl, buildGa4Payload, deterministicClientId, ga4EventNameForSource } from '../src/lib/ga4-conversions-sender'

const event = buildGa4Payload({
  companyId: 3,
  leadId: 42,
  eventId: 'schedule_3_42_1792687596000',
  eventName: 'Schedule',
  eventTime: new Date('2026-10-21T16:46:36.000Z'),
  value: 250,
  currency: 'BRL',
  email: ' Cliente@Exemplo.com ',
  phone: '5511999998888',
  source: 'google_ads',
  campaign: 'dr-lucas',
  gclid: 'EAIaIQobChMIteste',
})

assert.equal(ga4EventNameForSource('Purchase'), 'purchase')
assert.equal(ga4EventNameForSource('Schedule'), 'generate_lead')
assert.equal(event.events[0].name, 'generate_lead')
assert.equal(event.events[0].params.value, 250)
assert.equal(event.events[0].params.currency, 'BRL')
assert.equal(event.events[0].params.lead_type, 'appointment')
assert.equal(event.events[0].params.gclid, 'EAIaIQobChMIteste')
assert.match(event.client_id, /^\d{15}\.\d{15}$/)
assert.equal(event.client_id, deterministicClientId(3, 42, 'schedule_3_42_1792687596000'))
assert.match(event.user_id || '', /^[0-9a-f]{64}$/)
assert.ok(!JSON.stringify(event).includes('cliente@exemplo.com'))
assert.ok(!JSON.stringify(event).includes('5511999998888'))

const normalUrl = buildGa4CollectUrl('G-TEST123', 'secret', false)
const debugUrl = buildGa4CollectUrl('G-TEST123', 'secret', true)
assert.match(normalUrl, /^https:\/\/www\.google-analytics\.com\/mp\/collect\?/)
assert.match(debugUrl, /^https:\/\/www\.google-analytics\.com\/debug\/mp\/collect\?/)
assert.match(normalUrl, /measurement_id=G-TEST123/)

console.log('OK: payload GA4 usa eventos recomendados, client_id estável e endpoint debug separado.')
