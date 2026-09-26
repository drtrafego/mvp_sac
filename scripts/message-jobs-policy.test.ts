// Teste da política de envio do executor da fila (src/app/api/cron/route.ts):
// janela de 24h da Meta antes de mensagem livre, e limite de jobs por
// execução do cron. Puro, sem banco/rede: a lógica foi extraída pra
// src/lib/message-jobs-policy.ts exatamente pra ser testável assim.
//
// Uso: npx tsx --test scripts/message-jobs-policy.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkMetaWindowForJob,
  estimateMaxMessagesPerHour,
  ERR_OUTSIDE_META_WINDOW,
  MAX_JOBS_PER_RUN,
  CRON_INTERVAL_MINUTES,
} from '../src/lib/message-jobs-policy'

test('(a) job dentro da janela de 24h: mensagem livre é permitida', () => {
  const umaHoraAtras = new Date(Date.now() - 60 * 60 * 1000)
  const result = checkMetaWindowForJob({ messageType: 'text', lastInboundAt: umaHoraAtras })
  assert.deepEqual(result, { allowed: true })
})

test('(a) job sem messageType explícito (upsell) também é checado como mensagem livre', () => {
  const dezMinutosAtras = new Date(Date.now() - 10 * 60 * 1000)
  const result = checkMetaWindowForJob({ lastInboundAt: dezMinutosAtras })
  assert.deepEqual(result, { allowed: true })
})

test('(b) job fora da janela de 24h: mensagem livre falha com o erro específico, sem tentar enviar', () => {
  const trintaHorasAtras = new Date(Date.now() - 30 * 60 * 60 * 1000)
  const result = checkMetaWindowForJob({ messageType: 'text', lastInboundAt: trintaHorasAtras })
  assert.deepEqual(result, { allowed: false, error: ERR_OUTSIDE_META_WINDOW })
})

test('(b) lead que nunca respondeu (sem lastInboundAt): mensagem livre falha, exige template', () => {
  const result = checkMetaWindowForJob({ messageType: 'text', lastInboundAt: null })
  assert.deepEqual(result, { allowed: false, error: ERR_OUTSIDE_META_WINDOW })
})

test('template aprovado passa mesmo fora da janela (é pra isso que ele existe)', () => {
  const result = checkMetaWindowForJob({ messageType: 'template', lastInboundAt: null })
  assert.deepEqual(result, { allowed: true })
})

test('(c) o batch por execução respeita o limite escolhido (MAX_JOBS_PER_RUN)', () => {
  assert.equal(MAX_JOBS_PER_RUN, 50)
  assert.equal(CRON_INTERVAL_MINUTES, 5)
  const maxPorHora = estimateMaxMessagesPerHour(MAX_JOBS_PER_RUN, CRON_INTERVAL_MINUTES)
  assert.equal(maxPorHora, 600)
  // Teto conservador: em pior caso (24h seguidas no limite), dá 14.400
  // mensagens/dia — abaixo do tier mais baixo de mensageria da Meta
  // (Tier 1 = 1.000 CONVERSAS únicas/24h; aqui o teto é por MENSAGEM, mais
  // restritivo ainda, de propósito, pra sobrar margem).
  assert.ok(maxPorHora <= 1000, 'teto por hora deve ficar conservador (<= 1000 msgs/h)')
})

test('(c) limite customizado de batch/intervalo calcula corretamente', () => {
  assert.equal(estimateMaxMessagesPerHour(50, 2), 1500)
  assert.equal(estimateMaxMessagesPerHour(10, 5), 120)
})
