import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

type MessageRow = { mediaUrl: string | null }
type SettingsRow = { metaAccessToken: string | null }

let messageRows: MessageRow[] = []
let settingsRows: SettingsRow[] = []
let selectCalls = 0

const db = {
  select: () => {
    const call = selectCalls++
    return {
      from: () => ({
        where: () => ({
          limit: async () => call === 0 ? messageRows : settingsRows,
        }),
      }),
    }
  },
}

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/auth', { namedExports: { requireCompany: async () => ({ id: 7 }) } })

function configure(message: MessageRow[] = [], settings: SettingsRow[] = [{ metaAccessToken: 'segredo-de-teste' }]) {
  messageRows = message
  settingsRows = settings
  selectCalls = 0
}

function request(range?: string) {
  return new Request('https://sac.test/api/inbox/messages/42/audio', {
    headers: range ? { Range: range } : undefined,
  })
}

async function main() {
  const route = await import('../src/app/api/inbox/messages/[messageId]/audio/route')

  test('não encontra áudio de outra empresa', async () => {
    // O mock representa a consulta já filtrada por company_id=7: uma linha da
    // empresa 8 não pode retornar por essa consulta.
    configure([])
    const response = await route.GET(request(), { params: Promise.resolve({ messageId: '42' }) })
    assert.equal(response.status, 404)
    assert.equal(selectCalls, 1, 'não busca a credencial quando a mensagem não pertence à empresa')
  })

  test('não busca a Meta quando a mensagem não contém marcador wa-media válido', async () => {
    configure([{ mediaUrl: 'https://cdn.example.test/audio.ogg' }])
    const realFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => { fetchCalls++; throw new Error('não deveria chamar a Meta') }) as typeof fetch
    try {
      const response = await route.GET(request(), { params: Promise.resolve({ messageId: '42' }) })
      assert.equal(response.status, 404)
      assert.equal(fetchCalls, 0)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('rejeita URL de download que não é HTTPS em domínio Meta permitido', async () => {
    configure([{ mediaUrl: 'wa-media:1234567890' }])
    const realFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response(JSON.stringify({
        url: 'https://attacker.example/audio.ogg',
        mime_type: 'audio/ogg',
      }), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const response = await route.GET(request(), { params: Promise.resolve({ messageId: '42' }) })
      assert.equal(response.status, 502)
      assert.equal(fetchCalls, 1)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('devolve bytes de áudio, MIME Meta e nunca vaza o token', async () => {
    configure([{ mediaUrl: 'wa-media:1234567890' }])
    const realFetch = globalThis.fetch
    const calls: Array<{ url: string; authorization: string | null; range: string | null }> = []
    globalThis.fetch = (async (input, init) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(input),
        authorization: headers.get('authorization'),
        range: headers.get('range'),
      })
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          url: 'https://media.whatsapp.net/audio.ogg',
          mime_type: 'audio/ogg; codecs=opus',
        }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 206,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '4',
          'Content-Range': 'bytes 0-3/4',
          'Accept-Ranges': 'bytes',
        },
      })
    }) as typeof fetch
    try {
      const response = await route.GET(request('bytes=0-3'), { params: Promise.resolve({ messageId: '42' }) })
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('content-type'), 'audio/ogg; codecs=opus')
      assert.equal(response.headers.get('content-range'), 'bytes 0-3/4')
      assert.equal(response.headers.get('accept-ranges'), 'bytes')
      assert.equal(response.headers.get('cache-control'), 'private, max-age=300')
      assert.equal(response.headers.get('content-disposition'), 'inline')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4])
      assert.deepEqual(calls, [
        { url: 'https://graph.facebook.com/v19.0/1234567890', authorization: 'Bearer segredo-de-teste', range: null },
        { url: 'https://media.whatsapp.net/audio.ogg', authorization: 'Bearer segredo-de-teste', range: 'bytes=0-3' },
      ])
      const responseHeaders = [...response.headers.entries()].join('\n')
      assert.equal(responseHeaders.includes('segredo-de-teste'), false)
      assert.equal(responseHeaders.toLowerCase().includes('authorization'), false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('não segue redirect (token só vai a hosts da lista) e cancela o corpo do download recusado', async () => {
    configure([{ mediaUrl: 'wa-media:1234567890' }])
    const realFetch = globalThis.fetch
    const inits: Array<RequestInit | undefined> = []
    let cancelled = false
    globalThis.fetch = (async (_input, init) => {
      inits.push(init)
      if (inits.length === 1) {
        return new Response(JSON.stringify({ url: 'https://media.whatsapp.net/a.ogg', mime_type: 'audio/ogg' }), { headers: { 'Content-Type': 'application/json' } })
      }
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
      return new Response(body, { status: 302, headers: { Location: 'http://127.0.0.1/interno' } })
    }) as typeof fetch
    try {
      const response = await route.GET(request(), { params: Promise.resolve({ messageId: '42' }) })
      assert.equal(response.status, 502)
      assert.equal(inits.length, 2)
      assert.ok(inits.every(init => init?.redirect === 'manual'), 'os dois fetch usam redirect manual')
      assert.equal(cancelled, true)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('rejeita URL de download com porta diferente de 443', async () => {
    configure([{ mediaUrl: 'wa-media:1234567890' }])
    const realFetch = globalThis.fetch
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return new Response(JSON.stringify({ url: 'https://media.whatsapp.net:8443/a.ogg', mime_type: 'audio/ogg' }), { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const response = await route.GET(request(), { params: Promise.resolve({ messageId: '42' }) })
      assert.equal(response.status, 502)
      assert.equal(fetchCalls, 1)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test('redirect na consulta do Graph vira 502 sem seguir e cancela o corpo', async () => {
    configure([{ mediaUrl: 'wa-media:1234567890' }])
    const realFetch = globalThis.fetch
    let calls = 0
    let cancelled = false
    globalThis.fetch = (async () => {
      calls++
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true } })
      return new Response(body, { status: 302, headers: { Location: 'http://127.0.0.1/x' } })
    }) as typeof fetch
    try {
      const response = await route.GET(request(), { params: Promise.resolve({ messageId: '42' }) })
      assert.equal(response.status, 502)
      assert.equal(calls, 1)
      assert.equal(cancelled, true)
    } finally {
      globalThis.fetch = realFetch
    }
  })
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
