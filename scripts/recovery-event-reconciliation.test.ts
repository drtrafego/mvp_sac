import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  applyRecordedPurchaseTransition,
  isRecoveryEventType,
  RECOVERY_EVENT_TYPES,
  shouldScheduleRecoveryLead,
} from '../src/lib/recovery-event-reconciliation'

const routePaths = [
  '../src/app/api/webhooks/hotmart/[slug]/route.ts',
  '../src/app/api/webhooks/greenn/[slug]/route.ts',
  '../src/app/api/webhooks/zouti/[slug]/route.ts',
  '../src/app/api/webhooks/kiwify/[slug]/route.ts',
]

test('a conversão retroativa cobre exatamente os eventos de recuperação', () => {
  assert.deepEqual(RECOVERY_EVENT_TYPES, ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado'])
  assert.equal(isRecoveryEventType('carrinho_abandonado'), true)
  assert.equal(isRecoveryEventType('boleto'), true)
  assert.equal(isRecoveryEventType('pix'), true)
  assert.equal(isRecoveryEventType('compra_aprovada'), false)
})

test('carrinho abandonado passa a pago pelo webhook e sai da abordagem', () => {
  const pendingCart = { status: 'pending', convertedFrom: null }
  const paidCart = applyRecordedPurchaseTransition(pendingCart, true)

  assert.deepEqual(paidCart, { status: 'converted', convertedFrom: 'webhook' })
  assert.equal(shouldScheduleRecoveryLead(paidCart), false)
  assert.deepEqual(applyRecordedPurchaseTransition(paidCart, true), paidCart)
})

test('todos os webhooks de checkout reconciliam abandono que chega depois da compra', () => {
  for (const relativePath of routePaths) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    assert.match(source, /reconcileRecoveryLeadWithRecordedPurchase/)
    assert.match(source, /!alreadyConverted &&/)
    assert.match(source, /notificationPhone && !alreadyConverted/)
  }
})
