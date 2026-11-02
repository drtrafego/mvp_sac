import test from 'node:test'
import assert from 'node:assert/strict'
import {
  INSTAGRAM_COMMENT_DM_TEMPLATE,
  INSTAGRAM_COMMENT_DM_TEMPLATE_BODY,
  INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
  INSTAGRAM_COMMENT_DM_TEMPLATE_URL,
  buildInstagramCommentDmTemplateRegistration,
  renderInstagramCommentDmTemplate,
} from '../src/lib/instagram-comment-dm-template'
import { matchesCommentKeywords } from '../src/lib/instagram-comment-keywords'

test('template 021126 preserva o texto aprovado e usa a URL como única variável', () => {
  assert.equal(INSTAGRAM_COMMENT_DM_TEMPLATE_ID, '021126')
  assert.equal(INSTAGRAM_COMMENT_DM_TEMPLATE.variables.join(','), 'url')
  assert.match(renderInstagramCommentDmTemplate(), new RegExp(`${INSTAGRAM_COMMENT_DM_TEMPLATE_BODY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\n${INSTAGRAM_COMMENT_DM_TEMPLATE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))
  assert.throws(
    () => renderInstagramCommentDmTemplate({ url: 'https://example.com' as typeof INSTAGRAM_COMMENT_DM_TEMPLATE_URL }),
    /não pode ser alterada/,
  )
})

test('registro começa inativo e nunca habilita Página do Facebook', () => {
  const registration = buildInstagramCommentDmTemplateRegistration()
  assert.equal(registration.isActive, false)
  assert.equal(registration.mediaId, null)
  assert.equal(registration.consentRequired, true)
  assert.equal(registration.metaWindowHours, 168)
  assert.equal(registration.apiOrigin, 'instagram_graph')
  assert.equal(registration.publicReply, null)
  assert.equal(registration.hideCommentAfterReply, false)
  assert.equal(registration.templateVariables.url, INSTAGRAM_COMMENT_DM_TEMPLATE_URL)
  assert.throws(
    () => buildInstagramCommentDmTemplateRegistration({ isActive: true }),
    /mediaId real/,
  )
})

test('registro ativo exige um mediaId identificado', () => {
  const registration = buildInstagramCommentDmTemplateRegistration({ mediaId: '17890000000000000', isActive: true })
  assert.equal(registration.isActive, true)
  assert.equal(registration.mediaId, '17890000000000000')
  assert.equal(registration.keywords, 'Luana')
  assert.equal(registration.matchType, 'contains')
})

test('gatilho Luana é literal, case-insensitive e exige limite de palavra', () => {
  assert.equal(matchesCommentKeywords('Quero falar com LUANA!', 'Luana', 'contains').matched, true)
  assert.equal(matchesCommentKeywords('luanagem', 'Luana', 'contains').matched, false)
  assert.equal(matchesCommentKeywords('Quero falar com luana?', 'Luana', 'contains').matched, true)
})
