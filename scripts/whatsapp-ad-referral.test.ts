import assert from 'node:assert/strict'
import test from 'node:test'
import { extractAdReferral } from '../src/lib/whatsapp/ad-referral'

test('anúncio Click-to-WhatsApp: extrai id do anúncio, título e clid', () => {
  const r = extractAdReferral({ referral: { source_type: 'ad', source_id: '120248976767490686', headline: 'Anúncio 07', source_url: 'https://fb.me/x', ctwa_clid: 'AbC123' } })
  assert.deepEqual(r, { metaAdId: '120248976767490686', adName: 'Anúncio 07', sourceUrl: 'https://fb.me/x', ctwaClid: 'AbC123' })
})

test('sem referral, post orgânico ou lixo: não é anúncio', () => {
  assert.equal(extractAdReferral({}), null)
  assert.equal(extractAdReferral(null), null)
  assert.equal(extractAdReferral({ referral: [] }), null)
  assert.equal(extractAdReferral({ referral: { source_type: 'post', source_id: '123456' } }), null)
  assert.equal(extractAdReferral({ referral: { source_type: 'post', source_id: '123456', ctwa_clid: 'x' } })?.metaAdId, '123456')
  assert.equal(extractAdReferral({ referral: { source_type: 'other' } }), null)
})

test('source_id inválido vira null mas o lead continua marcado como anúncio', () => {
  const r = extractAdReferral({ referral: { source_type: 'ad', source_id: 'abc; drop', headline: 'x\u0000y' } })
  assert.equal(r?.metaAdId, null)
  assert.equal(r?.adName, 'x y')
})
