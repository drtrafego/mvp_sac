import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifySendMetric, aggregateChannelSendMetrics } from '../src/lib/channel-send-metrics'

test('aceito não significa entregue e accepted sem identificação permanece não confirmado', () => {
  assert.equal(classifySendMetric('accepted', true), 'accepted')
  assert.equal(classifySendMetric('accepted', false), 'unknown')
  assert.equal(classifySendMetric(null, true), 'unknown')
})
test('estados pendentes, falhos e incertos não compõem aceitação', () => {
  for (const state of ['pending', 'failed', 'uncertain'] as const) assert.equal(classifySendMetric(state, false), state)
})
test('métricas agrupam por canal e não replicam o total da empresa', () => {
  const data = aggregateChannelSendMetrics([
    { channel: 'whatsapp', sendState: 'accepted', hasExternalId: true, total: 3 },
    { channel: 'instagram', sendState: 'pending', hasExternalId: false, total: 2 },
    { channel: 'instagram', sendState: 'uncertain', hasExternalId: false, total: 1 },
    { channel: 'email', sendState: 'failed', hasExternalId: false, total: 4 },
  ])
  assert.deepEqual(data.get('instagram'), { total: 3, accepted: 0, failed: 0, pending: 2, uncertain: 1, unknown: 0 })
  assert.equal(data.get('whatsapp')?.total, 3)
  assert.equal(data.get('email')?.failed, 4)
})
test('histórico sem estado ou evidência tem contador separado e nenhum percentual inventado', () => {
  const data = aggregateChannelSendMetrics([
    { channel: 'email', sendState: null, hasExternalId: false, total: 5 },
    { channel: 'email', sendState: 'accepted', hasExternalId: false, total: 2 },
    { channel: null, sendState: 'pending', hasExternalId: false, total: 1 },
  ])
  assert.equal(data.get('email')?.unknown, 7)
  assert.equal(data.get('email')?.accepted, 0)
  assert.equal(data.get('unknown')?.total, 1)
})
