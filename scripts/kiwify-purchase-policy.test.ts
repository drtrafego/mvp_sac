import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shouldScheduleKiwifyMessageJobs } from '../src/lib/kiwify-purchase-policy'

const kiwifyRouteSource = readFileSync(resolve(process.cwd(), 'src/app/api/webhooks/kiwify/[slug]/route.ts'), 'utf8')

test('compra aprovada da Kiwify não cria jobs de mensagem', () => {
  assert.equal(shouldScheduleKiwifyMessageJobs('compra_aprovada'), false)
})

test('eventos de recuperação da Kiwify continuam elegíveis para jobs', () => {
  assert.equal(shouldScheduleKiwifyMessageJobs('pix'), true)
  assert.equal(shouldScheduleKiwifyMessageJobs('boleto'), true)
  assert.equal(shouldScheduleKiwifyMessageJobs('cartao_recusado'), true)
})

test('o webhook aplica a trava nos dois caminhos de criação de jobs', () => {
  assert.equal((kiwifyRouteSource.match(/shouldScheduleKiwifyMessageJobs\(mappedType\)/g) ?? []).length, 2)
  assert.match(kiwifyRouteSource, /insert\(recoveryLeads\)/)
  assert.doesNotMatch(kiwifyRouteSource, /delete\(recoveryLeads\)/)
  assert.doesNotMatch(kiwifyRouteSource, /insert\(whatsappMessages\)/)
})
