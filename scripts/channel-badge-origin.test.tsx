import assert from 'node:assert/strict'
import { parseOriginItem } from '../src/components/inbox/ChannelBadge'

const cases = [
  ['nina_anuncio', 'Meta Ads'],
  ['nina_anúncio', 'Meta Ads'],
  ['google_ads', 'Google Ads'],
  ['Meta Ads Dr. Lucas', 'Meta Ads Dr. Lucas'],
  ['Instagram Ads', 'Instagram Ads'],
] as const

for (const [raw, expectedLabel] of cases) {
  const parsed = parseOriginItem(raw)
  assert.ok(parsed, `origem ${raw} deveria ser reconhecida`)
  assert.equal(parsed.label, expectedLabel, `rótulo incorreto para ${raw}`)
}

assert.notEqual(parseOriginItem('nina_anuncio')?.label, 'Nina anuncio', 'nina_anuncio não pode vazar como texto cru')
assert.notEqual(parseOriginItem('google_ads')?.label, 'Google ads', 'google_ads não pode vazar como texto cru')

assert.equal(
  parseOriginItem('fonte_externa_desconhecida'),
  null,
  'origens desconhecidas não podem aparecer como texto cru',
)

console.log('channel-badge-origin: ok')
