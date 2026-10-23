import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateConversionRate } from '../src/lib/dashboard/conversion-rate'

test('taxa de conversao nao ultrapassa 100% mesmo com eventos duplicados', () => {
  const rate = calculateConversionRate(9, 1)
  assert.equal(rate.percentage, 100)
  assert.equal(rate.label, '100.0%')
})

test('taxa sem denominador fica sem dados, nao vira 0%', () => {
  const rate = calculateConversionRate(0, 0)
  assert.equal(rate.percentage, null)
  assert.equal(rate.label, 'Sem dados')
})

test('taxa normal preserva uma casa decimal', () => {
  const rate = calculateConversionRate(3, 10)
  assert.equal(rate.percentage, 30)
  assert.equal(rate.label, '30.0%')
})
