import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { extractHotmartToken } from '../src/lib/hotmart-token'
import { matchesCommentKeywords } from '../src/lib/instagram-comment-keywords'
import { parseIntegerQuery } from '../src/lib/request-validation'

process.env.MASTER_AGENT_TOKEN = 'segredo-de-teste'

mock.module('@/lib/agent-session', {
  namedExports: {
    createAgentSessionCookie: async () => 'sessao-assinada-de-teste',
  },
})

mock.module('@/lib/db', {
  namedExports: { db: {} },
})

let requireCompanyCalls = 0
mock.module('@/lib/auth', {
  namedExports: {
    requireCompany: async () => {
      requireCompanyCalls += 1
      return { id: 1 }
    },
  },
})

test('Hotmart aceita quando somente o header oficial X-HOTMART-HOTTOK está presente', () => {
  const headers = new Headers({ 'X-HOTMART-HOTTOK': 'hottok-oficial' })
  assert.equal(extractHotmartToken(headers, {}, 'https://app.example/webhook'), 'hottok-oficial')
})

test('Hotmart mantém o header legado como fallback', () => {
  const headers = new Headers({ 'x-hotmart-webhook-token': 'hottok-legado' })
  assert.equal(extractHotmartToken(headers, {}, 'https://app.example/webhook'), 'hottok-legado')
})

test('keyword com metacaractere de regex é tratada literalmente', () => {
  assert.doesNotThrow(() => matchesCommentKeywords('quero ( agora', '(', 'contains'))
  assert.deepEqual(matchesCommentKeywords('quero ( agora', '(', 'contains'), {
    matched: true,
    matchedKeyword: '(',
  })
  assert.equal(matchesCommentKeywords('aaab', 'a+b', 'contains').matched, false)
  assert.equal(matchesCommentKeywords('quero a+b agora', 'a+b', 'contains').matched, true)
})

test('parser de paginação rejeita valor não numérico e acima do teto', () => {
  const options = { defaultValue: 20, min: 1, max: 200, label: 'limit' }
  assert.equal(parseIntegerQuery('abc', options).ok, false)
  assert.equal(parseIntegerQuery('201', options).ok, false)
  const valid = parseIntegerQuery('200', options)
  assert.equal(valid.ok && valid.value, 200)
})

test('/api/leads devolve 400 para paginação inválida antes de consultar autenticação ou banco', async () => {
  const { GET } = await import('../src/app/api/leads/route')

  for (const query of ['limit=nao-numero', 'limit=201', 'offset=-1', 'offset=100001']) {
    const response = await GET(new NextRequest(`https://app.example/api/leads?${query}`))
    assert.equal(response.status, 400, query)
  }
  assert.equal(requireCompanyCalls, 0)
})

test('PATCH /api/comment-automations rejeita tipo inválido em todos os textos opcionais', async () => {
  const { PATCH } = await import('../src/app/api/comment-automations/[id]/route')
  const optionalTextFields = [
    'mediaId',
    'mediaUrl',
    'mediaCaption',
    'keywords',
    'publicReply',
    'activeHoursStart',
    'activeHoursEnd',
  ]

  for (const field of optionalTextFields) {
    const response = await PATCH(
      new NextRequest('https://app.example/api/comment-automations/123', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: {} }),
      }),
      { params: Promise.resolve({ id: '123' }) },
    )

    assert.equal(response.status, 400, field)
    assert.deepEqual(await response.json(), { error: `O campo ${field} deve ser um texto.` }, field)
  }
})

test('login de agente não aceita mais token em GET/query string', async () => {
  const { GET } = await import('../src/app/api/auth/agent-login/route')
  const response = await GET()
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'POST')
})

test('login de agente rejeita redirect protocol-relative para outro domínio', async () => {
  const { POST } = await import('../src/app/api/auth/agent-login/route')
  const response = await POST(new NextRequest('https://app.example/api/auth/agent-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'segredo-de-teste', redirect: '//evil.com/roubo' }),
  }))

  assert.equal(response.status, 400)
  assert.equal(response.headers.get('location'), null)
})

test('login de agente aceita destino relativo na mesma origem', async () => {
  const { POST } = await import('../src/app/api/auth/agent-login/route')
  const response = await POST(new NextRequest('https://app.example/api/auth/agent-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'segredo-de-teste', redirect: '/inbox?filtro=novo' }),
  }))

  assert.equal(response.status, 307)
  assert.equal(response.headers.get('location'), 'https://app.example/inbox?filtro=novo')
  assert.match(response.headers.get('set-cookie') ?? '', /agent_auth_session=/)
})
