import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildHealthFeatures, configurationStatus, healthIncidentTransition } from '@/lib/health/definitions'

test('lista somente funcionalidades realmente configuradas no tenant', () => {
  const features = buildHealthFeatures({
    whatsappProvider: 'meta',
    metaPhoneNumberId: 'phone-1',
    metaAccessToken: 'token-1',
    hotmartEnabled: true,
    hotmartWebhookToken: '',
  }, {}, 0)

  const keys = features.map(feature => feature.key)
  assert.deepEqual(keys, ['sac-session-api', 'database', 'queue-worker', 'channel-whatsapp-official'])
  assert.equal(features.at(-1)?.configured, true)
})

test('configuração parcial fica degradada e integração explicitamente desligada fica inativa', () => {
  const features = buildHealthFeatures({
    whatsappProvider: 'meta',
    metaPhoneNumberId: 'phone-1',
    metaAccessToken: '',
    kiwifyEnabled: false,
  }, {}, 0)

  const whatsapp = features.find(feature => feature.key === 'channel-whatsapp-official')!
  const kiwify = features.find(feature => feature.key === 'checkout-kiwify')!
  assert.equal(configurationStatus(whatsapp).status, 'degraded')
  assert.equal(configurationStatus(kiwify).status, 'inactive')
})

test('falha simulada abre um incidente, respeita cooldown e registra recuperação sem alertar fora do teste', () => {
  const first = new Date('2026-10-28T10:00:00.000Z')
  const cooldown = new Date('2026-10-28T10:10:00.000Z')
  const afterCooldown = new Date('2026-10-28T10:31:00.000Z')
  const healthy = { status: 'active' as const, critical: true }
  const failing = { status: 'failing' as const, critical: true }

  assert.equal(healthIncidentTransition(null, failing, first), 'opened')
  const openState = { isOpen: true, alertSentAt: first, nextAlertAt: new Date('2026-10-28T10:30:00.000Z') }
  assert.equal(healthIncidentTransition(openState, failing, cooldown), 'unchanged')
  assert.equal(healthIncidentTransition(openState, failing, afterCooldown), 'reminded')
  assert.equal(healthIncidentTransition(openState, healthy, afterCooldown), 'recovered')
  assert.equal(healthIncidentTransition({ isOpen: false, alertSentAt: first, nextAlertAt: null }, healthy, afterCooldown), 'unchanged')
})
