import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPublishRequest, parsePublishArgs, publishInstagramComment } from './publish-instagram-comment'

const env = {
  SAC_API_BASE_URL: 'https://sac.exemplo/',
  SAC_CODEX_EXECUTOR_KEY: 'executor-key-only-for-test',
}

test('runner exige confirmação, tenant, job e media_id numérico', () => {
  assert.throws(
    () => parsePublishArgs(['--tenant', 'empresa', '--job-id', 'job-1', '--media-id', '123', '--text-file', 'comentario.txt'], env),
    /--confirm explícito/,
  )

  const parsed = parsePublishArgs([
    '--tenant', 'empresa com espaço',
    '--job-id', 'job-1',
    '--media-id', '17841400000000000',
    '--text-file', 'comentario.txt',
    '--confirm',
  ], env)

  assert.equal(parsed.tenant, 'empresa com espaço')
  assert.equal(parsed.jobId, 'job-1')
  assert.equal(parsed.mediaId, '17841400000000000')
  assert.equal(parsed.confirmed, true)
  assert.throws(
    () => parsePublishArgs(['--tenant', 'empresa', '--job-id', 'job-1', '--media-id', 'url', '--text-file', 'comentario.txt', '--confirm'], env),
    /media-id precisa ser numérico/,
  )
})

test('runner monta somente o contrato oficial, com tenant no path e confirmação no header', () => {
  const { url, init } = buildPublishRequest({
    baseUrl: 'https://sac.exemplo/',
    tenant: 'empresa com espaço',
    jobId: 'job-1',
    mediaId: '17841400000000000',
    text: 'Olá, pessoal!',
    executorKey: 'executor-key-only-for-test',
    confirmed: true,
  })

  assert.equal(url, 'https://sac.exemplo/api/v1/companies/empresa%20com%20espa%C3%A7o/instagram/comments')
  assert.equal(init.method, 'POST')
  assert.equal((init.headers as Record<string, string>)['x-codex-confirmed'], 'true')
  assert.deepEqual(JSON.parse(String(init.body)), {
    jobId: 'job-1',
    mediaId: '17841400000000000',
    text: 'Olá, pessoal!',
  })
})

test('runner retorna bloqueio da API sem tentar outra rota', async () => {
  let calledUrl = ''
  const result = await publishInstagramComment({
    baseUrl: 'https://sac.exemplo',
    tenant: 'empresa',
    jobId: 'job-1',
    mediaId: '17841400000000000',
    text: 'Olá!',
    executorKey: 'executor-key-only-for-test',
    confirmed: true,
  }, async (input) => {
    calledUrl = String(input)
    return new Response(JSON.stringify({ error: 'Job está em aguardando_confirmacao; publicação bloqueada.' }), { status: 409 })
  })

  assert.equal(calledUrl, 'https://sac.exemplo/api/v1/companies/empresa/instagram/comments')
  assert.equal(result.status, 409)
  assert.deepEqual(result.body, { error: 'Job está em aguardando_confirmacao; publicação bloqueada.' })
})
