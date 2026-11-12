import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ISABELA_FORWARD_ONLY_DEFAULT_CUTOFF_AT,
  evaluateIsabelaForwardOnlyEvent,
  getIsabelaForwardOnlyCutoff,
} from '../src/lib/isabela-forward-only-policy'
import { formatDateSaoPaulo, isabelaFirstName, isabelaOrderReference } from '../src/lib/isabela-template-values'

const cutoff = ISABELA_FORWARD_ONLY_DEFAULT_CUTOFF_AT

test('Isabela bloqueia evento anterior ao corte e aceita o próprio instante do corte', () => {
  assert.deepEqual(
    evaluateIsabelaForwardOnlyEvent('isabela-fanini', new Date(cutoff.getTime() - 1), {}),
    { allowed: false, reason: 'evento_isabela_anterior_ao_corte' },
  )
  assert.deepEqual(evaluateIsabelaForwardOnlyEvent('isabela-fanini', new Date(cutoff.getTime()), {}), { allowed: true })
})

test('sem data de ocorrência a Isabela falha fechada; outros workspaces não usam a política', () => {
  assert.deepEqual(
    evaluateIsabelaForwardOnlyEvent('isabela-fanini', null, {}),
    { allowed: false, reason: 'evento_isabela_sem_data_de_ocorrencia' },
  )
  assert.deepEqual(
    evaluateIsabelaForwardOnlyEvent('isabela-fanini', new Date('invalid'), {}),
    { allowed: false, reason: 'evento_isabela_sem_data_de_ocorrencia' },
  )
  for (const slug of ['autonomia', 'gramado-plaza', 'dr-lucas', 'nina', 'carol', null, undefined]) {
    assert.deepEqual(evaluateIsabelaForwardOnlyEvent(slug, null, {}), { allowed: true }, String(slug))
    assert.deepEqual(evaluateIsabelaForwardOnlyEvent(slug, new Date('2020-01-01'), {}), { allowed: true }, String(slug))
  }
})

test('ISABELA_FORWARD_ONLY_SINCE (momento do deploy) sobrescreve o corte padrão; valor inválido falha fechado', () => {
  const deploy = '2026-11-13T09:00:00-03:00'
  assert.equal(getIsabelaForwardOnlyCutoff({ ISABELA_FORWARD_ONLY_SINCE: deploy })?.toISOString(), new Date(deploy).toISOString())
  assert.deepEqual(
    evaluateIsabelaForwardOnlyEvent('isabela-fanini', new Date('2026-11-13T08:59:00-03:00'), { ISABELA_FORWARD_ONLY_SINCE: deploy }),
    { allowed: false, reason: 'evento_isabela_anterior_ao_corte' },
  )
  assert.deepEqual(
    evaluateIsabelaForwardOnlyEvent('isabela-fanini', new Date('2026-11-13T09:00:00-03:00'), { ISABELA_FORWARD_ONLY_SINCE: deploy }),
    { allowed: true },
  )
  assert.deepEqual(
    evaluateIsabelaForwardOnlyEvent('isabela-fanini', new Date(), { ISABELA_FORWARD_ONLY_SINCE: 'amanha' }),
    { allowed: false, reason: 'evento_isabela_corte_invalido' },
  )
})

test('valores dos templates da Isabela: primeiro nome, order_ref curto e data no fuso de São Paulo', () => {
  assert.equal(isabelaFirstName('MARIA DA SILVA SANTOS'), 'Maria')
  assert.equal(isabelaFirstName('joana pereira'), 'Joana')
  assert.equal(isabelaFirstName('Ana Paula Souza'), 'Ana')
  assert.equal(isabelaFirstName('  '), 'Cliente')
  assert.equal(isabelaFirstName(null), 'Cliente')
  assert.equal(isabelaOrderReference({ rawPayload: { order_ref: ' Ab12Cd7 ' }, transactionId: '0a1b2c3d-0000-4000-8000-000000000001' }), 'Ab12Cd7')
  assert.equal(isabelaOrderReference({ rawPayload: { order_ref: '' }, transactionId: 'uuid-1' }), 'uuid-1')
  assert.equal(isabelaOrderReference({ rawPayload: null, transactionId: 'uuid-1' }), 'uuid-1')
  // vencimento 31/12 23:59 BRT = 01/01 02:59 UTC: em UTC viraria o dia errado
  assert.equal(formatDateSaoPaulo(new Date('2030-12-31T23:59:00-03:00')), '31/12/2030')
  assert.equal(formatDateSaoPaulo(null), '')
})
