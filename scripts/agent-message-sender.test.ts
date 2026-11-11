// Rótulo de quem falou nas mensagens espelhadas do banco dos agentes.
// Uso: npm run test:gabi-pause-mirror
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { senderForAgentMessage } from '../src/lib/agent-message-sender'

test('fala do dono do restaurante (prefixo) na Gramado vira human; o texto não muda', () => {
  assert.equal(senderForAgentMessage({ schema: 'gramadoplazza', role: 'assistant', content: '[atendente do restaurante] Pode vir às 20h' }), 'human')
  assert.equal(senderForAgentMessage({ schema: 'gramadoplazza', role: 'assistant', content: '  [Atendente do Restaurante] ok' }), 'human')
})

test('a Gabi (sem prefixo) e o cliente seguem como antes', () => {
  assert.equal(senderForAgentMessage({ schema: 'gramadoplazza', role: 'assistant', content: 'Oi! Sou a Gabi.' }), 'bot')
  assert.equal(senderForAgentMessage({ schema: 'gramadoplazza', role: 'user', content: '[atendente do restaurante] x' }), 'user', 'cliente nunca vira humano do restaurante')
  assert.equal(senderForAgentMessage({ schema: 'gramadoplazza', role: 'assistant', content: 'Falei com o [atendente do restaurante] ontem' }), 'bot', 'prefixo só vale no início')
})

test('outros agentes não são afetados', () => {
  assert.equal(senderForAgentMessage({ schema: 'drlucas', role: 'assistant', content: '[atendente do restaurante] x' }), 'bot')
  assert.equal(senderForAgentMessage({ schema: 'gramadoplazza', role: null, content: null }), 'bot')
})
