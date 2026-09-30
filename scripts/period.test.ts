import { test } from 'node:test'
import assert from 'node:assert/strict'
import { endOfMonth, resolvePeriod, startOfMonth } from '../src/lib/period'

const NOW = new Date('2026-09-30T15:00:00.000Z') // 2026-09-30 12:00 BRT

test('from/to explicito tem precedencia sobre period', () => {
  assert.deepEqual(resolvePeriod({ period: '7d', from: '2026-09-01', to: '2026-09-10', now: NOW }), {
    from: '2026-09-01',
    to: '2026-09-10',
  })
})

test('resolve periodos relativos em datas equivalentes em BRT', () => {
  assert.deepEqual(resolvePeriod({ period: 'today', now: NOW }), { from: '2026-09-30', to: '2026-09-30' })
  assert.deepEqual(resolvePeriod({ period: 'yesterday', now: NOW }), { from: '2026-09-29', to: '2026-09-29' })
  assert.deepEqual(resolvePeriod({ period: '7d', now: NOW }), { from: '2026-09-24', to: '2026-09-30' })
  assert.deepEqual(resolvePeriod({ period: '14d', now: NOW }), { from: '2026-09-17', to: '2026-09-30' })
  assert.deepEqual(resolvePeriod({ period: '30d', now: NOW }), { from: '2026-09-01', to: '2026-09-30' })
})

test('month vai do primeiro dia do mes ate hoje, sem incluir futuro', () => {
  assert.deepEqual(resolvePeriod({ period: 'month', now: new Date('2026-09-12T15:00:00.000Z') }), {
    from: '2026-09-01',
    to: '2026-09-12',
  })
  assert.equal(startOfMonth('2026-09-12'), '2026-09-01')
  assert.equal(endOfMonth('2026-09-12'), '2026-09-30')
})

test('all usa o inicio operacional fixo do SAC e custom aceita from sem to', () => {
  assert.deepEqual(resolvePeriod({ period: 'all', now: NOW }), { from: '2026-01-01', to: '2026-09-30' })
  assert.deepEqual(resolvePeriod({ period: 'custom', from: '2026-09-20', now: NOW }), {
    from: '2026-09-20',
    to: '2026-09-30',
  })
})
