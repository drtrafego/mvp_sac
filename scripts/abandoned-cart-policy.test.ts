import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { shouldScheduleRecoveryMessageJobs, shouldSendRecoveryNotification } from '../src/lib/recovery-event-policy'

const origins = [
  ['greenn', '../src/app/api/webhooks/greenn/[slug]/route.ts'],
  ['hotmart', '../src/app/api/webhooks/hotmart/[slug]/route.ts'],
  ['kiwify', '../src/app/api/webhooks/kiwify/[slug]/route.ts'],
  ['zouti', '../src/app/api/webhooks/zouti/[slug]/route.ts'],
] as const

test('carrinho abandonado mantém contato/estado, mas não agenda nem notifica', () => {
  assert.equal(shouldScheduleRecoveryMessageJobs('carrinho_abandonado'), false)
  assert.equal(shouldSendRecoveryNotification('carrinho_abandonado'), false)
  assert.equal(shouldScheduleRecoveryMessageJobs('pix'), true)
  assert.equal(shouldScheduleRecoveryMessageJobs('boleto'), true)
  assert.equal(shouldScheduleRecoveryMessageJobs('cartao_recusado'), true)
  assert.equal(shouldScheduleRecoveryMessageJobs('compra_aprovada'), false)
})

test('cada origem aplica a política nos jobs e na notificação interna', () => {
  for (const [origin, relativePath] of origins) {
    const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    assert.match(source, /shouldSchedule(?:KiwifyMessageJobs|RecoveryMessageJobs)\(mappedType\)/, origin)
    assert.match(source, /shouldSendRecoveryNotification\(mappedType\)/, origin)
    assert.doesNotMatch(source, /if \(sequence\) \{/, origin)
  }
})

test('a política de visibilidade preserva conversas com mensagem e oculta cartões vazios', () => {
  const source = readFileSync(new URL('../src/lib/inbox-conversation-policy.ts', import.meta.url), 'utf8')
  assert.match(source, /ABANDONED_CART_EVENT/)
  assert.match(source, /PURCHASE_APPROVED_EVENT/)
  assert.match(source, /NOT EXISTS/)
  assert.match(source, /whatsapp_messages abandoned_cart_history/)
  assert.match(source, /abandoned_cart_history\.lead_id = .*recoveryLeads\.id/)
})

test('a migração cancela jobs antigos sem apagar dados', () => {
  const source = readFileSync(new URL('../drizzle/0038_abandoned_cart_no_conversations.sql', import.meta.url), 'utf8')
  assert.match(source, /UPDATE message_jobs/)
  assert.match(source, /status IN \('pending', 'processing'\)/)
  assert.doesNotMatch(source, /DELETE FROM/i)
  assert.doesNotMatch(source, /recovery_leads.*DELETE/i)
})

test('o cron cancela jobs antigos de carrinho antes de qualquer envio', () => {
  const source = readFileSync(new URL('../src/app/api/cron/route.ts', import.meta.url), 'utf8')
  assert.match(source, /leadEventType: recoveryLeads\.eventType/)
  assert.match(source, /leadEventType === ABANDONED_CART_EVENT/)
  assert.match(source, /status: 'cancelled'/)
})
