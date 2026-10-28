import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import * as schema from '../src/lib/db/schema'

let failSidebarLookup = false
let hasMineracaoLead = false
const settingsWithoutInstagramConnection = {
  instagramAccountId: null,
  instagramPageId: null,
  instagramAccessToken: null,
  metaAccessToken: null,
  brevoApiKey: 'brevo-key',
  brevoSenderEmail: 'sac@example.com',
  sidebarConfig: { showInstagram: true },
}

const db = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => {
        if (failSidebarLookup) throw new Error('banco indisponível')
        if (table === schema.settings) return Promise.resolve([settingsWithoutInstagramConnection])
        if (table === schema.recoveryLeads) return { limit: async () => hasMineracaoLead ? [{ id: 1 }] : [] }
        if (table === schema.instagramCommentAutomations) return { limit: async () => [] }
        throw new Error('Tabela inesperada')
      },
    }),
  }),
}

mock.module('@/lib/db', { namedExports: { db } })

test('status operacional não é reativado por configuração visual e fallback fecha Hotmart', async () => {
  const { getCompanySidebarData } = await import('../src/lib/company-sidebar')
  const regular = await getCompanySidebarData(1)
  assert.equal(regular.activeConnections.instagram, false)

  failSidebarLookup = true
  try {
    const fallback = await getCompanySidebarData(1)
    assert.equal(fallback.activeConnections.hotmart, false)
    assert.equal(fallback.activeConnections.instagram, false)
  } finally {
    failSidebarLookup = false
  }
})

test('Brevo não cria Mineração, mas um lead de Mineração real a habilita', async () => {
  const { getCompanySidebarData } = await import('../src/lib/company-sidebar')
  assert.equal((await getCompanySidebarData(1)).activeConnections.mineracao, false)

  hasMineracaoLead = true
  try {
    assert.equal((await getCompanySidebarData(1)).activeConnections.mineracao, true)
  } finally {
    hasMineracaoLead = false
  }
})

test('desktop e menu móvel recebem o mesmo contexto e Instagram só pode ser ocultado', async () => {
  const layout = await readFile(new URL('../src/app/(dashboard)/layout.tsx', import.meta.url), 'utf8')
  assert.match(layout, /<MobileTabBar isAdmin activeConnections=\{activeConnections\} sidebarConfig=\{sidebarConfig\} \/>/)
  assert.match(layout, /<MobileTabBar activeConnections=\{activeConnections\} sidebarConfig=\{sidebarConfig\} \/>/)

  const { resolveSidebarVisibility } = await import('../src/components/layout/sidebar')
  assert.equal(resolveSidebarVisibility({ instagram: false }, { showInstagram: true }).instagram, false)
  assert.equal(resolveSidebarVisibility({ instagram: true }, { showInstagram: true }).instagram, true)
  assert.equal(resolveSidebarVisibility({ instagram: true }, { showInstagram: false }).instagram, false)
})
