import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { getInstagramInboundTagTriggers, isInstagramStoryReply } from '../src/lib/instagram-inbound-tags'

test('resposta de Story só avalia regras story_reply', () => {
  assert.equal(isInstagramStoryReply({ reply_to: { story: { id: 'story-1' } } }), true)
  assert.equal(isInstagramStoryReply({ reply_to: { mid: 'message-1' } }), false)
  assert.deepEqual(getInstagramInboundTagTriggers(true), ['story_reply'])
  assert.deepEqual(getInstagramInboundTagTriggers(false), ['direct'])
})

test('webhook persiste tag e mensagem pelo contrato atômico antes do ACK', async () => {
  for (const path of [
    'src/app/api/webhooks/instagram/route.ts',
    'src/app/api/webhooks/instagram/[slug]/route.ts',
  ]) {
    const source = await readFile(path, 'utf8')
    assert.ok(source.includes('persistInstagramInboundWithTags'))
    assert.ok(source.includes('InstagramInboundPersistenceError'))
  }
})

test('tag de comentário consulta lead no escopo da empresa', async () => {
  const source = await readFile('src/lib/instagram-comment-processor.ts', 'utf8')
  assert.match(source, /eq\(recoveryLeads\.companyId, companyId\)/)
  assert.match(source, /tag: normalizeTag\(matchedRule\.autoTag\)/)
})

test('rotas de escrita exigem administrador e respondem 403', async () => {
  for (const path of [
    'src/app/api/instagram-tag-rules/route.ts',
    'src/app/api/instagram-tag-rules/[id]/route.ts',
  ]) {
    const source = await readFile(path, 'utf8')
    assert.match(source, /requireCompanyRole\('admin'\)/)
    assert.match(source, /forbiddenResponse\(\)/)
  }
})
