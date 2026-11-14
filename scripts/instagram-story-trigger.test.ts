import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { matchesCommentKeywords } from '../src/lib/instagram-comment-keywords'
import { isInstagramStoryReplyMessage, STORY_PROTECTED_SLUGS } from '../src/lib/instagram-story-trigger'
import { isStoryTriggerEnabledForSlug } from '../src/lib/instagram-story-automation'

async function fixture(name: string) { return JSON.parse(await readFile(resolve(process.cwd(), `scripts/fixtures/instagram-story/${name}`), 'utf8')) as { entry: Array<{ messaging: Array<{ message?: unknown; reaction?: unknown }> }> } }

test('resposta textual e resposta só com emoji mantêm reply_to.story e casam os tipos de regra', async () => {
  const text = (await fixture('reply-text.json')).entry[0].messaging[0].message
  const emoji = (await fixture('reply-emoji.json')).entry[0].messaging[0].message
  assert.equal(isInstagramStoryReplyMessage(text as Parameters<typeof isInstagramStoryReplyMessage>[0]), true)
  assert.equal(isInstagramStoryReplyMessage(emoji as Parameters<typeof isInstagramStoryReplyMessage>[0]), true)
  assert.equal(matchesCommentKeywords('QUERO', 'quero', 'exact').matched, true)
  assert.equal(matchesCommentKeywords('🔥', '', 'any').matched, true)
  assert.equal(matchesCommentKeywords('🔥', 'quero', 'contains').matched, false)
})

test('reaction de eco não é resposta a Story e a proteção é exclusiva da Isabela', async () => {
  const reaction = (await fixture('reaction-echo.json')).entry[0].messaging[0]
  assert.equal(isInstagramStoryReplyMessage(reaction.message as never), false)
  assert.ok(STORY_PROTECTED_SLUGS.includes('isabela-fanini'))
  assert.ok(!STORY_PROTECTED_SLUGS.includes('outra-empresa' as never))
  assert.equal(isStoryTriggerEnabledForSlug('outra-empresa'), true)
  assert.equal(isStoryTriggerEnabledForSlug(''), false)
})

test('migração é estritamente aditiva e cria a trava de envio único', async () => {
  const migration = await readFile(resolve(process.cwd(), 'drizzle/0045_instagram_story_trigger.sql'), 'utf8')
  assert.match(migration, /CREATE TABLE IF NOT EXISTS instagram_story_automations/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS instagram_story_deliveries/)
  assert.match(migration, /ON instagram_story_deliveries\(company_id, sender_id, story_id\)/)
  assert.doesNotMatch(migration, /ALTER TABLE|DROP TABLE/i)
})
