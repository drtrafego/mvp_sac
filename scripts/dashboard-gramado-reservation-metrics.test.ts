import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GRAMADO_VALID_RESERVATION_STATUSES,
  isGramadoValidReservationStatus,
  summarizeGramadoReservationMetrics,
} from '../src/lib/dashboard/gramado-reservations'

test('metricas de reserva do Gramado usam status valido, data real e soma de pessoas', () => {
  // Status reais confirmados em producao (company_id=4, 02/10/2026):
  // compareceu=928, cancelou=232, nao_compareceu=97, pendente=60. So
  // "compareceu" representa atendimento real; "pendente" e reserva ainda
  // sem desfecho e NAO conta (bate com o sistema nativo do Gastao).
  assert.deepEqual(GRAMADO_VALID_RESERVATION_STATUSES, ['compareceu'])
  assert.equal(isGramadoValidReservationStatus('compareceu'), true)
  assert.equal(isGramadoValidReservationStatus('pendente'), false)
  assert.equal(isGramadoValidReservationStatus('cancelou'), false)
  assert.equal(isGramadoValidReservationStatus('nao_compareceu'), false)

  const metrics = summarizeGramadoReservationMetrics(
    [
      { data: '2026-10-01', status: 'pendente', pessoas: 2 },
      { data: '2026-10-02', status: 'compareceu', pessoas: 5 },
      { data: '2026-10-01', status: 'cancelou', pessoas: 10 },
      { data: '2026-10-01', status: 'nao_compareceu', pessoas: 8 },
      {
        data: '2026-09-30',
        status: 'compareceu',
        pessoas: 99,
        activityAt: '2026-10-01T18:00:00.000Z',
      },
      { data: '2026-10-03', status: 'compareceu', pessoas: 6 },
    ],
    '2026-10-01',
    '2026-10-02',
  )

  // Só a linha '2026-10-02'/compareceu está dentro do período E tem status
  // válido. A de 2026-09-30/compareceu fica de fora por data (mesmo com
  // status valido e activityAt dentro do período — a data REAL da reserva
  // manda, não a atividade). A de 2026-10-03/compareceu fica de fora por
  // data futura ao período.
  assert.equal(metrics.totalReservas, 1)
  assert.equal(metrics.totalPessoas, 5)
})
