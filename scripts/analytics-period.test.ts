import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAnalyticsPeriod } from '../src/lib/analytics-period'

test('aceita data de fim inclusiva para YYYY-MM-DD', () => {
  const period = resolveAnalyticsPeriod('2026-10-01', '2026-10-14')
  assert.ok(!('error' in period))
  assert.equal(period.fromDate.toISOString(), '2026-10-01T00:00:00.000Z')
  assert.equal(period.toDate.toISOString(), '2026-10-14T23:59:59.999Z')
})

test('rejeita datas inválidas e período invertido', () => {
  assert.deepEqual(resolveAnalyticsPeriod('2026-02-30', null), {
    error: 'Parâmetro "from" inválido. Use YYYY-MM-DD ou data ISO 8601.',
  })
  assert.deepEqual(resolveAnalyticsPeriod(null, 'invalida'), {
    error: 'Parâmetro "to" inválido. Use YYYY-MM-DD ou data ISO 8601.',
  })
  assert.deepEqual(resolveAnalyticsPeriod('2026-10-15', '2026-10-14'), {
    error: 'O parâmetro "from" deve ser anterior ou igual a "to".',
  })
})

test('usa janela padrão de 30 dias até o instante atual quando não recebe período', () => {
  const now = new Date('2026-10-14T15:00:00.000Z')
  const period = resolveAnalyticsPeriod(null, null, now)
  assert.ok(!('error' in period))
  assert.equal(period.fromDate.toISOString(), '2026-09-14T15:00:00.000Z')
  assert.equal(period.toDate.toISOString(), '2026-10-14T15:00:00.000Z')
})
