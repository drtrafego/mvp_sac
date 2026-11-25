import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveMassDispatchDisplayStatus } from '../src/lib/mass-dispatch'

test('histórico exibe entrega quando o job foi entregue mesmo com lote persistido como queued', () => {
  assert.equal(deriveMassDispatchDisplayStatus([
    { status: 'sent', deliveryStatus: 'delivered' },
  ], 'queued'), 'delivered')
})

test('status derivado preserva pendência e falha parcial', () => {
  assert.equal(deriveMassDispatchDisplayStatus([
    { status: 'pending', deliveryStatus: null },
    { status: 'sent', deliveryStatus: 'delivered' },
  ], 'queued'), 'queued')
  assert.equal(deriveMassDispatchDisplayStatus([
    { status: 'failed', deliveryStatus: null },
    { status: 'sent', deliveryStatus: 'delivered' },
  ], 'queued'), 'partial_failure')
})
