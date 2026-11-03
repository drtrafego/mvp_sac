import assert from 'node:assert/strict'
import test from 'node:test'
import { withTimeout } from '../src/lib/with-timeout'

test('withTimeout deixa uma carga rápida passar e limpa o timer', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 50, 'timeout'), 'ok')
})

test('withTimeout transforma uma carga presa em erro reproduzível', async () => {
  const startedAt = Date.now()
  await assert.rejects(
    () => withTimeout(new Promise<string>(() => undefined), 20, 'Inbox load timeout'),
    /Inbox load timeout/,
  )
  assert.ok(Date.now() - startedAt < 500, 'a tela não pode aguardar indefinidamente')
})
