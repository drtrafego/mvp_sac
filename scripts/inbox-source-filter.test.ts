import assert from 'node:assert/strict'
import { matchesInboxSourceFilter } from '../src/lib/inbox-source-filter'

assert.equal(
  matchesInboxSourceFilter({ trackingSource: 'agente_ia', platform: 'sac' }, 'agente_ia'),
  true,
  'matches raw trackingSource from dashboard acquisition bars'
)

assert.equal(
  matchesInboxSourceFilter({ trackingSource: 'meta_ads_instagram', platform: null }, 'meta_ads'),
  true,
  'matches partial source values, same broad semantics used by the dashboard'
)

assert.equal(
  matchesInboxSourceFilter({ trackingSource: null, platform: '' }, 'Direto / Orgânico'),
  true,
  'matches synthetic direct/organic source for empty tracking fields'
)

assert.equal(
  matchesInboxSourceFilter({ trackingSource: 'whatsapp_sac', platform: 'whatsapp' }, 'agente_ia'),
  false,
  'does not match unrelated sources'
)

console.log('inbox-source-filter: ok')
