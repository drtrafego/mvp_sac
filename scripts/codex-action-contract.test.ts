import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CODEX_ACTION_ALLOWLIST, containsSecretLikeText, isAllowlistedCodexIntent, parseCodexIntent, safeActionContext, stableCodexIdempotencyKey, validateAudioUpload } from '../src/lib/codex-actions'
import { transcribeWithHermes } from '../src/lib/hermes-transcriber'

test('reconhece intenção de comentário e mantém media_id explícito', () => {
  const parsed = parseCodexIntent('Crie este comentário no Instagram: "Olá, pessoal!"', { mediaId: '17841400000000000' })
  assert.equal(parsed.intent, 'instagram.comment.create')
  assert.equal(parsed.targetText, 'Olá, pessoal!')
  assert.equal(parsed.mediaId, '17841400000000000')
})

test('texto sem operação externa não vira comentário', () => {
  assert.equal(parseCodexIntent('Mostre o status do atendimento').intent, 'generic.request')
  assert.equal(isAllowlistedCodexIntent('generic.request'), false)
  assert.deepEqual(CODEX_ACTION_ALLOWLIST, ['instagram.comment.create'])
})

test('contexto é reduzido a chaves não secretas e idempotência é estável', () => {
  const context = safeActionContext({ surface: 'painel_sac', mediaId: 'não deveria entrar', token: 'secret' })
  assert.deepEqual(context, { surface: 'painel_sac' })
  assert.equal(stableCodexIdempotencyKey(1, 'session', 'texto', '42', 'comentário'), stableCodexIdempotencyKey(1, 'session', 'texto', '42', 'comentário'))
  assert.equal(containsSecretLikeText('Authorization: Bearer abcdefghijklmnop'), true)
})

test('áudio aplica limite e allowlist de tipo', () => {
  assert.equal(validateAudioUpload(1024, 'audio/ogg'), null)
  assert.match(validateAudioUpload(26 * 1024 * 1024, 'audio/ogg') ?? '', /25 MB/)
  assert.match(validateAudioUpload(1024, 'application/octet-stream') ?? '', /Tipo de áudio/)
})

test('Whisper local usa o contrato real video_path e remove o arquivo temporário', async () => {
  const oldUrl = process.env.HERMES_TRANSCRIBE_URL
  const oldSharedDir = process.env.HERMES_TRANSCRIBE_SHARED_DIR
  const originalFetch = globalThis.fetch
  const sharedDir = await mkdtemp(join(tmpdir(), 'codex-hermes-test-'))
  let requestBody: Record<string, unknown> | null = null
  let sentFileContents: Buffer | null = null
  try {
    process.env.HERMES_TRANSCRIBE_URL = 'http://127.0.0.1:8765/transcribe'
    process.env.HERMES_TRANSCRIBE_SHARED_DIR = sharedDir
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      const path = String(requestBody.video_path)
      sentFileContents = await readFile(path)
      return new Response(JSON.stringify({ status: 'success', text: 'texto local' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const file = { type: 'audio/ogg', arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer } as unknown as File
    const result = await transcribeWithHermes(file)

    assert.equal(result.transcript, 'texto local')
    assert.equal(result.provider, 'hermes-local')
    assert.deepEqual(sentFileContents, Buffer.from([1, 2, 3]))
    assert.equal(typeof requestBody?.video_path, 'string')
    assert.equal(requestBody?.language, 'pt')
    assert.equal('data_url' in (requestBody ?? {}), false)
    await assert.rejects(() => stat(String(requestBody?.video_path)), { code: 'ENOENT' })
  } finally {
    globalThis.fetch = originalFetch
    if (oldUrl === undefined) delete process.env.HERMES_TRANSCRIBE_URL
    else process.env.HERMES_TRANSCRIBE_URL = oldUrl
    if (oldSharedDir === undefined) delete process.env.HERMES_TRANSCRIBE_SHARED_DIR
    else process.env.HERMES_TRANSCRIBE_SHARED_DIR = oldSharedDir
    await rm(sharedDir, { recursive: true, force: true })
  }
})
