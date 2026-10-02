// Teste de regressão para ITEM 2:
// Prioridade de ID na resposta de comentário e DM do Instagram em src/lib/instagram.ts
//
// Contexto do bug:
// sendInstagramPrivateReply e sendInstagramMessage usavam o Facebook Page ID
// (instagram_page_id) ANTES do Instagram Account ID (instagram_account_id).
// Comentários nativos do Instagram pertencem à conta do Instagram, não à Page do
// Facebook conectada — gerando erro na Meta:
// "Unsupported post request. Object with ID '...' does not exist..."
//
// Correção:
// const pageId = config?.instagramAccountId || config?.instagramPageId || 'me'
//
// Execução:
// node --experimental-test-module-mocks --import tsx scripts/instagram-page-id-priority.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'

const CONTAINER_NAME = 'instagram_page_id_priority_test'

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return r.status === 0
}

async function pickFreePortAsync(): Promise<number> {
  const net = await import('node:net')
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object' && addr) {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('não deu pra alocar porta livre')))
      }
    })
  })
}

async function startDisposablePostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await pickFreePortAsync()
  execFileSync('docker', [
    'run', '--rm', '-d',
    '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test',
    '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`,
    'postgres:16-alpine',
  ])

  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 })
      await probe`select 1`
      await probe.end({ timeout: 1 })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, 500))
    }
  }
  if (lastErr) throw new Error(`postgres descartável não respondeu a tempo: ${String(lastErr)}`)

  return {
    url,
    stop: () => {
      spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
    },
  }
}

// Configuração do mock de DB e fetch
let testSettingsRow: any = {
  companyId: 1,
  instagramAccountId: 'ig_acc_999999',
  instagramPageId: 'fb_page_888888',
  instagramAccessToken: 'fake_token_123',
}

const mockDb = {
  select: () => ({
    from: () => ({
      where: async () => testSettingsRow ? [testSettingsRow] : [],
    }),
  }),
}

mock.module('@/lib/db', {
  namedExports: { db: mockDb },
})

const fetchCalls: Array<{ url: string; options: any }> = []
const originalFetch = globalThis.fetch

// @ts-ignore
globalThis.fetch = async (url: string | URL | Request, options?: any) => {
  const urlStr = typeof url === 'string' ? url : url.toString()
  fetchCalls.push({ url: urlStr, options })
  return {
    ok: true,
    json: async () => ({ message_id: 'mid.mocked.123' }),
  } as any
}

test('sendInstagramPrivateReply prioriza instagramAccountId sobre instagramPageId', async () => {
  const { sendInstagramPrivateReply } = await import('../src/lib/instagram')

  fetchCalls.length = 0
  testSettingsRow = {
    companyId: 1,
    instagramAccountId: 'ig_acc_999999',
    instagramPageId: 'fb_page_888888',
    instagramAccessToken: 'fake_token_123',
  }

  const result = await sendInstagramPrivateReply({
    commentId: 'comment_123',
    text: 'Olá resposta privada',
    companyId: 1,
  })

  assert.equal(result.ok, true)
  assert.equal(fetchCalls.length, 1)
  assert.equal(
    fetchCalls[0].url,
    'https://graph.instagram.com/v21.0/ig_acc_999999/messages',
    'Deveria chamar a URL com instagramAccountId e NÃO instagramPageId'
  )
})

test('sendInstagramMessage prioriza instagramAccountId sobre instagramPageId', async () => {
  const { sendInstagramMessage } = await import('../src/lib/instagram')

  fetchCalls.length = 0
  testSettingsRow = {
    companyId: 1,
    instagramAccountId: 'ig_acc_999999',
    instagramPageId: 'fb_page_888888',
    instagramAccessToken: 'fake_token_123',
  }

  const result = await sendInstagramMessage({
    recipientId: 'user_456',
    text: 'Olá direct normal',
    companyId: 1,
  })

  assert.equal(result.ok, true)
  assert.equal(fetchCalls.length, 1)
  assert.equal(
    fetchCalls[0].url,
    'https://graph.instagram.com/v21.0/ig_acc_999999/messages',
    'Deveria chamar a URL com instagramAccountId e NÃO instagramPageId'
  )
})

test('sendInstagramPrivateReply faz fallback para instagramPageId quando instagramAccountId estiver ausente', async () => {
  const { sendInstagramPrivateReply } = await import('../src/lib/instagram')

  fetchCalls.length = 0
  testSettingsRow = {
    companyId: 1,
    instagramAccountId: null,
    instagramPageId: 'fb_page_888888',
    instagramAccessToken: 'fake_token_123',
  }

  const result = await sendInstagramPrivateReply({
    commentId: 'comment_123',
    text: 'Olá fallback',
    companyId: 1,
  })

  assert.equal(result.ok, true)
  assert.equal(fetchCalls.length, 1)
  assert.equal(
    fetchCalls[0].url,
    'https://graph.instagram.com/v21.0/fb_page_888888/messages',
    'Deveria fazer fallback para instagramPageId quando instagramAccountId for nulo'
  )
})

test('sendInstagramMessage faz fallback para "me" quando ambos IDs estiverem ausentes', async () => {
  const { sendInstagramMessage } = await import('../src/lib/instagram')

  fetchCalls.length = 0
  testSettingsRow = {
    companyId: 1,
    instagramAccountId: null,
    instagramPageId: null,
    instagramAccessToken: 'fake_token_123',
  }

  const result = await sendInstagramMessage({
    recipientId: 'user_456',
    text: 'Olá fallback me',
    companyId: 1,
  })

  assert.equal(result.ok, true)
  assert.equal(fetchCalls.length, 1)
  assert.equal(
    fetchCalls[0].url,
    'https://graph.instagram.com/v21.0/me/messages',
    'Deveria fazer fallback para "me" quando nenhum ID estiver preenchido'
  )
})
