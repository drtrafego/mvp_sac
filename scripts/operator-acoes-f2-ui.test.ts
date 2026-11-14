import assert from 'node:assert/strict'
import { test, before, mock } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActionView } from '../src/lib/operator/acoes/types'
let slots: unknown[] = []
let cursor = 0
let effects: Array<() => void | (() => void)> = []
const exports = Object.fromEntries(Object.entries(React).filter(([key]) => key !== 'default'))
mock.module('react', { defaultExport: exports, namedExports: { ...exports,
  useState: (initial: unknown) => { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }] },
  useId: () => 'campo-teste', useEffect: (effect: () => void | (() => void)) => { effects.push(effect) },
} })
let Card: typeof import('../src/components/operator/confirmation-card').ConfirmationCard
let Actions: typeof import('../src/components/operator/job-actions').OperatorJobActions
before(async () => { Card = (await import('../src/components/operator/confirmation-card')).ConfirmationCard; Actions = (await import('../src/components/operator/job-actions')).OperatorJobActions })
const action: ActionView = { id: 'a', tipo: 'criar_regra_instagram', resumo: 'Criar regra', status: 'aguardando_confirmacao', podeDesfazer: false, desfeita: false,
  cartao: { mensagem: '<script>test()</script> https://example.test', palavra: 'CADERNO', correspondencia: 'Contém a palavra', alcance: 'Comentários novos em TODOS os posts.', dominios: ['example.test'], avisos: ['Domínio não verificado: example.test.'], codigo: 'CADERNO' } }
type Element = React.ReactElement<{ children?: React.ReactNode; onClick?: () => void; onChange?: (e: { target: { value: string } }) => void; disabled?: boolean }>
function find(node: React.ReactNode, predicate: (el: Element) => boolean): Element | undefined {
  if (Array.isArray(node)) { for (const n of node) { const got = find(n, predicate); if (got) return got } }
  else if (React.isValidElement(node)) { const el = node as Element; if (predicate(el)) return el; return find(el.props.children, predicate) }
}
function reset() { slots = []; cursor = 0; effects = [] }

test('Cartão aberto mostra texto puro, palavra, domínio, alcance e prazo; exige digitação', () => {
  reset(); let confirmed = ''; let cancelled = 0
  const props = { actions: [action], expiresAt: new Date(Date.now() + 900000).toISOString(), busy: false, onConfirm: (value: string) => { confirmed = value }, onCancel: () => { cancelled++ } }
  const draw = () => { cursor = 0; return Card(props) }
  let tree = draw()
  assert.equal(find(tree, el => el.props.children === 'Confirmar')?.props.disabled, true)
  const html = renderToStaticMarkup(tree)
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/)
  for (const text of ['TODOS os posts','example.test','CADERNO','Prazo restante','Domínio não verificado']) assert.ok(html.includes(text))
  find(tree, el => el.type === 'input')!.props.onChange!({ target: { value: 'CADERNO' } })
  tree = draw(); assert.equal(find(tree, el => el.props.children === 'Confirmar')!.props.disabled, false)
  find(tree, el => el.props.children === 'Confirmar')!.props.onClick!(); assert.equal(confirmed, 'CADERNO')
  find(tree, el => el.props.children === 'Cancelar')!.props.onClick!(); assert.equal(cancelled, 1)
})
test('Expirado e ocupado bloqueiam confirmação; estado terminal não exibe cartão', () => {
  for (const busy of [false, true]) {
    reset(); slots = ['CADERNO', Date.now()]
    const tree = Card({ actions: [action], expiresAt: new Date(Date.now() - 1000).toISOString(), busy, onConfirm: () => assert.fail(), onCancel: () => {} })
    assert.equal(find(tree, el => el.props.children === 'Confirmar')!.props.disabled, true)
    assert.match(renderToStaticMarkup(tree), /prazo de 15 minutos venceu/)
  }
  reset(); assert.equal(Card({ actions: [{ ...action, cartao: undefined }], expiresAt: new Date().toISOString(), busy: false, onConfirm: () => {}, onCancel: () => {} }), null)
})
test('R5: falha de GET oferece nova tentativa e o segundo GET recupera o seletor/cartão', async () => {
  reset(); let calls = 0
  const fetch = mock.method(globalThis, 'fetch', async () => { calls++; if (calls === 1) throw new Error('Falha de rede'); return Response.json({ acoes: [action], job: { planHash: 'a'.repeat(64), confirmationExpiresAt: new Date(Date.now() + 900000).toISOString() } }) })
  const props = { job: { id: 'j', status: 'aguardando_confirmacao', resultJson: { acoes: true } }, onChange: async () => {} }
  try {
    Actions(props); effects.at(-1)!(); await new Promise(resolve => setImmediate(resolve))
    cursor = 0; const failed = Actions(props)
    const retry = find(failed, el => el.props.children === 'Tentar carregar novamente'); assert.ok(retry)
    retry.props.onClick!()
    cursor = 0; Actions(props); effects.at(-1)!(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 2)
    cursor = 0; const recovered = Actions(props)
    assert.equal(find(recovered, el => el.props.children === 'Tentar carregar novamente'), undefined)
    assert.ok(find(recovered, el => el.type === Card))
  } finally { fetch.mock.restore() }
})
