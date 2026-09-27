import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

// Mocks mínimos antes do import dinâmico evitam inicializar conexões ao carregar sync-agents.ts.
mock.module('@/lib/db', {
  namedExports: { db: {} },
})

mock.module('@/lib/db/agents-db', {
  namedExports: {
    getAgentsDbUrl: async () => '',
    queryAgentsDb: async () => [],
  },
})

async function main() {
  const { realCampaignSource } = await import('../src/lib/sync-agents')

  await test('neutraliza prospeccao para empresa comum', () => {
    assert.equal(realCampaignSource('prospeccao', false), null)
  })

  await test('mantém prospeccao para empresa de mineração', () => {
    assert.equal(realCampaignSource('prospeccao', true), 'prospeccao')
  })

  await test('neutraliza mineracao_direct para empresa comum', () => {
    assert.equal(realCampaignSource('mineracao_direct', false), null)
  })

  await test('mantém fonte legítima sem palavra reservada', () => {
    assert.equal(realCampaignSource('facebook_grupo_vip', false), 'facebook_grupo_vip')
  })

  await test('mantém whatsapp como fonte genérica', () => {
    assert.equal(realCampaignSource('whatsapp', false), null)
  })

  await test('mantém normalização de ads para meta_ads', () => {
    assert.equal(realCampaignSource('ads', false), 'meta_ads')
  })

  await test('neutraliza Prospecção com acento e maiúscula para empresa comum', () => {
    assert.equal(realCampaignSource('Prospecção', false), null)
  })

  await test('neutraliza MINERAÇÃO com acento e caixa alta para empresa comum', () => {
    assert.equal(realCampaignSource('MINERAÇÃO', false), null)
  })

  await test('mantém Prospecção com acento para empresa de mineração de verdade', () => {
    assert.equal(realCampaignSource('Prospecção', true), 'Prospecção')
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
