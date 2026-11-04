import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getDateRange } from '../src/lib/date-utils'

const NOW = new Date('2026-11-04T15:00:00.000Z')

test('modo all não cria início artificial e mantém limite superior', () => {
  const range = getDateRange('all', NOW)

  assert.equal(range.fromDate, null)
  assert.equal(range.toDate.getTime(), NOW.getTime())
})

test('datas explícitas continuam limitando o período escolhido', () => {
  const range = getDateRange('all', NOW, '2024-05-10', '2024-05-12')

  assert.equal(range.fromDate?.toISOString(), '2024-05-10T03:00:00.000Z')
  assert.equal(range.toDate.toISOString(), '2024-05-13T02:59:59.999Z')
})
