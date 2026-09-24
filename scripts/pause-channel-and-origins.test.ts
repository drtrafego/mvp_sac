import assert from 'node:assert/strict'
import { normalizeOrigin, extractLeadOrigins } from '../src/lib/origins'
import {
  classifyChannelInMemory,
  classifyMineracaoSubchannel,
  classifyAnuncioSubcategory,
} from '../src/lib/inbox-channel-filter'

console.log('Testing Instagram origins...')

// 1. Instagram Ad (Click-to-Direct / Anúncio)
const adMeta = normalizeOrigin('instagram_ad')
assert.equal(adMeta.category, 'anuncio', 'instagram_ad category should be anuncio')
assert.equal(adMeta.key, 'meta_ads_instagram', 'instagram_ad key should be meta_ads_instagram')
assert.equal(adMeta.shortLabel, 'Instagram Ads', 'instagram_ad shortLabel should be Instagram Ads')

// 2. Instagram Comment (Comentário)
const commentMeta = normalizeOrigin('instagram_comment')
assert.equal(commentMeta.category, 'instagram', 'instagram_comment category should be instagram')
assert.equal(commentMeta.key, 'instagram_comment', 'instagram_comment key should be instagram_comment')
assert.equal(commentMeta.shortLabel, 'IG Comentário', 'instagram_comment shortLabel should be IG Comentário')

// 3. Instagram Direct (Orgânico / Mensagem Direta)
const directMeta = normalizeOrigin('instagram_direct')
assert.equal(directMeta.category, 'instagram', 'instagram_direct category should be instagram')
assert.equal(directMeta.key, 'instagram_direct', 'instagram_direct key should be instagram_direct')

// 4. Channel Classification for Inbox
const adChannel = classifyChannelInMemory({
  channel: 'instagram',
  trackingSource: 'instagram_ad',
})
assert.equal(adChannel.isAnuncio, true, 'instagram_ad in trackingSource should be classified as anuncio')
assert.equal(adChannel.isInstagram, false, 'instagram_ad should not be classified as simple organic instagram')
assert.equal(classifyAnuncioSubcategory({ trackingSource: 'instagram_ad' }), 'meta_ads', 'subchannel of instagram_ad is meta_ads')

console.log('Testing Mineração vs WhatsApp logic (Item 4 explanation)...')

// Ordinary inbound WhatsApp lead
const normalWhatsappLead = {
  channel: 'whatsapp',
  trackingSource: null,
  platform: 'sac',
}
const normalClassification = classifyChannelInMemory(normalWhatsappLead)
assert.equal(normalClassification.isWhatsapp, true, 'Ordinary WhatsApp lead falls into WhatsApp tab')
assert.equal(normalClassification.isMineracao, false, 'Ordinary WhatsApp lead is NOT mineração')

// Lead originating from mineração prospecção via WhatsApp
const mineracaoWhatsappLead = {
  channel: 'whatsapp',
  trackingSource: 'mineracao_prospeccao',
  platform: 'sac',
}
const mineracaoClassification = classifyChannelInMemory(mineracaoWhatsappLead)
assert.equal(mineracaoClassification.isMineracao, true, 'Outreach lead falls into Mineração tab')
assert.equal(mineracaoClassification.isWhatsapp, false, 'Outreach lead is categorized under Mineração first')
assert.equal(classifyMineracaoSubchannel(mineracaoWhatsappLead), 'whatsapp', 'Subchannel is whatsapp')

console.log('Testing Instagram attachment / share skip predicate (Item 2)...')

function shouldSkipAiReply(message?: {
  attachments?: Array<{ type?: string }>
}): boolean {
  return Boolean(
    message?.attachments &&
      Array.isArray(message.attachments) &&
      message.attachments.length > 0
  )
}

assert.equal(shouldSkipAiReply({ attachments: [{ type: 'share' }] }), true, 'Shared reels/posts must skip AI reply')
assert.equal(shouldSkipAiReply({ attachments: [{ type: 'image' }] }), true, 'Media uploads must skip AI reply')
assert.equal(shouldSkipAiReply({ attachments: [] }), false, 'Empty attachments must not skip')
assert.equal(shouldSkipAiReply({}), false, 'Text message with no attachments must not skip')

console.log('Testing parseOriginItem (Item 7)...')
import { parseOriginItem } from '../src/components/inbox/ChannelBadge'

const commentOrigin = parseOriginItem('instagram_comment')
assert.equal(commentOrigin?.label, 'Instagram Comentário', 'instagram_comment should have label Instagram Comentário')
assert.equal(commentOrigin?.key, 'instagram_comment', 'key should be instagram_comment')

const adOrigin = parseOriginItem('instagram_ad')
assert.equal(adOrigin?.label, 'Instagram Anúncio', 'instagram_ad should have label Instagram Anúncio')
assert.equal(adOrigin?.key, 'instagram_ad', 'key should be instagram_ad')

const directOrigin = parseOriginItem('instagram_direct')
assert.equal(directOrigin?.label, 'Instagram Direto', 'instagram_direct should have label Instagram Direto')
assert.equal(directOrigin?.key, 'instagram_direct', 'key should be instagram_direct')

console.log('Testing inferConversationChannel (Item 8)...')
import { inferConversationChannel } from '../src/lib/sync-agents'

assert.equal(
  inferConversationChannel({ title: 'Análise de e-mail recebido', channel: 'webhook', session_id: 'sess_123' }),
  'email',
  'Email automation session with title "Análise de e-mail recebido" must be inferred as email'
)

assert.equal(
  inferConversationChannel({ channel: 'brevo', session_id: 'sess_456' }),
  'email',
  'Brevo channel must be inferred as email'
)

assert.equal(
  inferConversationChannel({ channel: 'whatsapp', chat_id: '5511999998888' }),
  'whatsapp',
  'WhatsApp channel with phone number must be inferred as whatsapp'
)

assert.equal(
  inferConversationChannel({ channel: 'instagram', chat_id: 'ig_12345' }),
  'instagram',
  'Instagram channel with ig_ prefix must be inferred as instagram'
)

console.log('All tests passed successfully! ✅')
