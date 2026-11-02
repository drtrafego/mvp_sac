import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APPROVED_LUANA_COMMENT_REPLY,
  INSTAGRAM_COMMENT_JOB_INTENT,
  enumerateEligibleLuanaCommentEvents,
  isEligibleLuanaCommentEvent,
  isLuanaTriggerComment,
  prepareLuanaCommentJob,
} from '../src/lib/instagram-comment-event-automation'

function event(overrides: Partial<Parameters<typeof isEligibleLuanaCommentEvent>[0]> = {}) {
  return {
    companyId: 42,
    entryAccountId: '17841400000000000',
    acceptedAccountIds: ['17841400000000000', 'page-42'],
    commentId: '17900000000000001',
    commenterId: '17900000000000002',
    commenterUsername: 'pessoa',
    mediaId: '17890000000000001',
    commentText: 'Quero conhecer a Luana!',
    ...overrides,
  }
}

test('gatilho aceita variação de caixa e exige a palavra Luana', () => {
  assert.equal(isLuanaTriggerComment('LUANA, quero saber mais'), true)
  assert.equal(isLuanaTriggerComment('lUAnA?'), true)
  assert.equal(isLuanaTriggerComment('lunar'), false)
})

test('enumera qualquer post elegível, explicita media_ids, deduplica comentário e aplica limite', () => {
  const result = enumerateEligibleLuanaCommentEvents([
    event(),
    event({ commentId: '17900000000000003', mediaId: '17890000000000002' }),
    event(),
    event({ commentId: '17900000000000004', mediaId: '17890000000000003' }),
  ], 2)

  assert.deepEqual(result.mediaIds, ['17890000000000001', '17890000000000002'])
  assert.deepEqual(result.events.map(item => item.commentId), ['17900000000000001', '17900000000000003'])
  assert.deepEqual(result.skipped.map(item => item.reason), ['comment_duplicado_no_lote', 'limite_do_lote'])
})

test('filtro bloqueia media_id inválido e evento de outro tenant', () => {
  assert.deepEqual(isEligibleLuanaCommentEvent(event({ mediaId: 'post-url' })), { eligible: false, reason: 'media_id_invalido' })
  assert.deepEqual(isEligibleLuanaCommentEvent(event({ entryAccountId: 'conta-errada' })), { eligible: false, reason: 'conta_fora_do_tenant' })
})

test('preparação cria um job aguardando confirmação, audita, deduplica e não publica', async () => {
  const jobs: Array<Record<string, unknown>> = []
  const audits: Array<Record<string, unknown>> = []
  let selectQuery = 0
  let fetchCalled = false
  const fakeDb = {
    select: () => {
      selectQuery += 1
      return {
      from: () => ({
        where: () => ({
          limit: async () => {
            if (selectQuery === 3 && jobs.length > 0) return [{ jobId: jobs[0].jobId, mediaId: jobs[0].mediaId }]
            return []
          },
          then: (resolve: (value: Array<{ count: number }>) => unknown) => resolve([{ count: 0 }]),
        }),
      }),
      }
    },
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        if (value.jobId) {
          jobs.push(value)
          return { onConflictDoNothing: () => ({ returning: async () => [{ jobId: value.jobId }] }) }
        }
        audits.push(value)
        return Promise.resolve([])
      },
    }),
  } as never

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalled = true
    throw new Error('publicação não deveria ser chamada na preparação')
  }) as typeof fetch
  try {
    const first = await prepareLuanaCommentJob(event(), fakeDb)
    const second = await prepareLuanaCommentJob(event(), fakeDb)

    assert.equal(first.status, 'prepared')
    assert.equal(second.status, 'duplicate')
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0].intent, INSTAGRAM_COMMENT_JOB_INTENT)
    assert.equal(jobs[0].status, 'aguardando_confirmacao')
    assert.equal(jobs[0].mediaId, '17890000000000001')
    assert.equal(jobs[0].targetText, APPROVED_LUANA_COMMENT_REPLY)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].type, 'instagram_luana_comment_job_prepared')
    assert.equal(fetchCalled, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
