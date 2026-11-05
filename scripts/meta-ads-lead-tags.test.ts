import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { extractMetaLeadIdentifiers, isProvenMetaAdsEvidence, META_AD_TAG } from '../src/lib/meta-ads-lead-tag'

const tagsRoute = readFileSync(new URL('../src/app/api/leads/[leadId]/tags/route.ts', import.meta.url), 'utf8')
const helper = readFileSync(new URL('../src/lib/meta-ads-lead-tag.ts', import.meta.url), 'utf8')
const chatWindow = readFileSync(new URL('../src/components/inbox/ChatWindow.tsx', import.meta.url), 'utf8')
const v1LeadsRoute = readFileSync(new URL('../src/app/api/v1/companies/[idOrSlug]/leads/route.ts', import.meta.url), 'utf8')

test('payload Meta Ads comprovado recebe a tag canônica e não depende de nome textual', () => {
  assert.equal(isProvenMetaAdsEvidence({
    trackingSource: 'meta_ads',
    platform: 'sac',
    metaAdId: '120000000000001',
  }), true)
  assert.equal(META_AD_TAG, 'anuncio')
})

test('orgânico, Direct e WhatsApp sem evidência não são convertidos em Meta Ads', () => {
  assert.equal(isProvenMetaAdsEvidence({ platform: 'whatsapp', channel: 'whatsapp' } as never), false)
  assert.equal(isProvenMetaAdsEvidence({ trackingSource: 'instagram_direct', platform: 'instagram' }), false)
  assert.equal(isProvenMetaAdsEvidence({
    platform: 'whatsapp',
    trackingSource: 'whatsapp',
    rawPayload: { source: 'whatsapp' },
  }), false)
  assert.equal(isProvenMetaAdsEvidence({
    platform: 'sac',
    utmCampaign: 'campanha com nome de anúncio',
    rawPayload: { campaign_name: 'campanha com nome de anúncio' },
  } as never), false)
})

test('registro CTWA é prova e a persistência é idempotente por constraint', () => {
  assert.equal(isProvenMetaAdsEvidence({
    trackingSource: 'meta_ads',
    rawPayload: { source: 'ctwa_referrals', referral: { source_id: 'ad-1' } },
  }), true)
  assert.match(helper, /onConflictDoNothing\(\)/)
  assert.match(helper, /eq\(recoveryLeads\.companyId, companyId\)/)
  assert.match(tagsRoute, /META_AD_EVIDENCE_REQUIRED/)
})

test('identificadores form_id e leadgen_id são extraídos e exibidos como origem técnica', () => {
  const ids = extractMetaLeadIdentifiers({
    object: 'page',
    entry: [{ changes: [{ value: { leadgen_id: 'lead-456', form_id: 'form-9' } }] }],
  })
  assert.deepEqual(ids, { formId: 'form-9', leadgenId: 'lead-456' })
  assert.match(chatWindow, /LeadAttributionCard/)
  assert.match(v1LeadsRoute, /metaFormId: metaLeadIds\.formId/)
  assert.match(v1LeadsRoute, /metaLeadgenId: metaLeadIds\.leadgenId/)
})

test('edição pelo card passa pela API de tags e a origem factual não é um campo do editor', () => {
  assert.match(chatWindow, /<LeadTags leadId=\{lead\.id\}/)
  assert.match(tagsRoute, /eq\(recoveryLeads\.id, id\)/)
  assert.match(tagsRoute, /eq\(recoveryLeads\.companyId, company\.id\)/)
  assert.doesNotMatch(chatWindow, /trackingSource=.*onChange|metaAdId=.*onChange/)
})

console.log('meta-ads-lead-tags: ok')
