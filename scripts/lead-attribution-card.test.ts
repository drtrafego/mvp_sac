import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLeadAttributionRows } from '../src/components/inbox/lead-attribution'

function rows(input: Parameters<typeof buildLeadAttributionRows>[0]) {
  return Object.fromEntries(buildLeadAttributionRows(input).map(row => [row.key, row]))
}

test('card mostra Meta Ads, nomes e IDs preservados na persistência', () => {
  const card = rows({
    platform: 'instagram',
    channel: 'instagram',
    trackingSource: 'meta_ads',
    utmCampaign: '[ENG] Empresários',
    adsetName: 'Conjunto remarketing',
    adName: 'Criativo depoimento',
    metaCampaignId: 'campaign-1',
    metaAdsetId: 'adset-2',
    metaAdId: 'ad-3',
    metaFormId: 'form-9',
    metaLeadgenId: 'lead-456',
  })

  assert.equal(card.origin.value, 'Meta Ads')
  assert.equal(card.platform.value, 'Instagram')
  assert.equal(card.campaign.value, '[ENG] Empresários · ID campaign-1')
  assert.equal(card.adset.value, 'Conjunto remarketing · ID adset-2')
  assert.equal(card.ad.value, 'Criativo depoimento · ID ad-3')
  assert.equal(card.form.value, 'form-9')
  assert.equal(card.leadgen.value, 'lead-456')
})

test('card não transforma contato orgânico em anúncio e deixa lacunas explícitas', () => {
  const card = rows({ platform: 'instagram', channel: 'instagram', trackingSource: 'instagram_direct' })

  assert.equal(card.origin.value, 'Instagram Direct')
  assert.equal(card.campaign.value, 'Não informado')
  assert.equal(card.adset.value, 'Não informado')
  assert.equal(card.ad.value, 'Não informado')
  assert.equal(card.campaign.available, false)
})

test('IDs Meta isolados bastam para confirmar atribuição sem inventar nomes', () => {
  const card = rows({ platform: 'meta_lead_ads', channel: 'whatsapp', metaAdId: 'ad-99' })

  assert.equal(card.origin.value, 'Meta Ads')
  assert.equal(card.campaign.value, 'Não informado')
  assert.equal(card.ad.value, 'ID ad-99')
})

test('nome de campanha/conjunto/anúncio sem sinal factual não muda a origem', () => {
  const card = rows({
    platform: 'whatsapp',
    channel: 'whatsapp',
    trackingSource: 'whatsapp',
    utmCampaign: 'Campanha orgânica',
    adsetName: 'Conjunto nomeado',
    adName: 'Anúncio citado no CRM',
  })

  assert.equal(card.origin.value, 'WhatsApp direto')
})

console.log('lead-attribution-card: ok')
