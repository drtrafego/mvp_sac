import assert from 'node:assert/strict'
import test from 'node:test'
import { InboxClientError, readInboxResponse } from '../src/lib/inbox-client'

const page = { conversations: [], nextCursor: null, hasMore: false }

test('Inbox aceita somente a resposta JSON paginada esperada', async () => {
  const response = new Response(JSON.stringify(page), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  assert.deepEqual(await readInboxResponse(response), page)
})

test('Inbox transforma 401 em estado explícito de sessão', async () => {
  const response = new Response(JSON.stringify({ error: 'Não autenticado', code: 'UNAUTHORIZED' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  })
  await assert.rejects(
    () => readInboxResponse(response),
    (error: unknown) => error instanceof InboxClientError && error.code === 'unauthorized',
  )
})

test('Inbox detecta redirect seguido para a tela de login em vez de tratar HTML como lista vazia', async () => {
  const response = new Response('<html>login</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })
  Object.defineProperty(response, 'url', { value: 'https://sac.example/handler/sign-in?after_auth_return_to=%2Finbox' })
  Object.defineProperty(response, 'redirected', { value: true })
  await assert.rejects(
    () => readInboxResponse(response),
    (error: unknown) => error instanceof InboxClientError && error.code === 'unauthorized',
  )
})

test('Inbox rejeita payload de API incompleto', async () => {
  const response = new Response(JSON.stringify({ conversations: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  await assert.rejects(
    () => readInboxResponse(response),
    (error: unknown) => error instanceof InboxClientError && error.code === 'invalid-response',
  )
})
