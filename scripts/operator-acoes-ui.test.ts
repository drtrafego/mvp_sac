import assert from 'node:assert/strict'
import { before, test, mock } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActionView } from '../src/lib/operator/acoes/types'

// Injeta estados e captura efeitos, mantendo o JSX e os componentes reais.
// Não simula o servidor: o teste HTTP de 50 cartões está na integração PostgreSQL.
let arrays: unknown[][] = []
let effects: Array<() => void | (() => void)> = []
const reactExports = Object.fromEntries(Object.entries(React).filter(([key]) => key !== 'default'))
mock.module('react', { defaultExport: { ...reactExports }, namedExports: { ...reactExports,
  useState: (initial: unknown) => [Array.isArray(initial) ? arrays.shift() ?? initial : initial, () => {}],
  useEffect: (effect: () => void | (() => void)) => { effects.push(effect) },
} })
let OperatorConsole: typeof import('../src/components/operator/operator-console').OperatorConsole
let OperatorJobActions: typeof import('../src/components/operator/job-actions').OperatorJobActions
before(async () => {
  OperatorConsole = (await import('../src/components/operator/operator-console')).OperatorConsole
  OperatorJobActions = (await import('../src/components/operator/job-actions')).OperatorJobActions
})
const noop = async () => {}
const action: ActionView = { id: 'acao', tipo: 'mover_etapa', status: 'concluido', resumo: 'Mover M***.', podeDesfazer: true, desfeita: false }

test('50 cartões: só dez recentes e todos em espera carregam ações; novo seletor permanece visível', async () => {
  const jobs = Array.from({ length: 50 }, (_, i) => ({ id: `job-${i}`, status: i === 49 ? 'aguardando_confirmacao' : 'concluido', requestText: 'Pedido', createdAt: new Date().toISOString(), resultJson: { acoes: true } }))
  const calls: string[] = []
  const fetch = mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => { calls.push(String(url)); return Response.json({ acoes: [] }) })
  const waiting: ActionView = { ...action, status: 'pendente', podeDesfazer: false, esclarecimento: { tipo: 'lead', candidatos: [{ leadId: 7, rotulo: 'F***', telefoneFinal: '1234', etapa: 'novo_contato' }] } }
  try {
    for (const history of [jobs, [{ ...jobs[0], id: 'novo', status: 'aguardando_confirmacao' }, ...jobs]]) {
      calls.length = 0; effects = []
      arrays = [history, ...history.filter((job, i) => i < 10 || job.status === 'aguardando_confirmacao').map(job => job.status === 'aguardando_confirmacao' ? [waiting] : [])]
      const html = renderToStaticMarkup(React.createElement(OperatorConsole))
      assert.match(html, /Qual lead você quer alterar/)
      assert.match(html, /final 1234/)
      // O primeiro efeito é o polling do histórico, os demais são GET /acoes.
      const cleanups = effects.slice(1).map(effect => effect())
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(calls.length, 11)
      assert.ok(calls.includes('/api/operator/jobs/job-49/acoes'))
      assert.equal(calls.some(url => url.includes('/job-20/')), false)
      if (history.length === 51) assert.ok(calls.includes('/api/operator/jobs/novo/acoes'))
      for (const cleanup of cleanups) cleanup?.()
    }
  } finally { fetch.mock.restore() }
})

test('Desfazer conflitante esconde o botão e mostra motivo em português; códigos não vazam', () => {
  arrays = [[{ ...action, podeDesfazer: false, erroDesfazer: 'CONFLICT' }, { ...action, id: 'falhou', status: 'falhou', podeDesfazer: false, erro: 'INVALID_NOTE' }]]
  effects = []
  const html = renderToStaticMarkup(React.createElement(OperatorJobActions, { job: { id: 'job', status: 'concluido', resultJson: { acoes: true } }, onChange: noop }))
  assert.match(html, /Mudou depois, não desfeito/)
  assert.match(html, /A nota é inválida/)
  assert.doesNotMatch(html, /CONFLICT|INVALID_NOTE|>Desfazer</)
})
