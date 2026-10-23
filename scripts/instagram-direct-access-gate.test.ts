import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as schema from '../src/lib/db/schema'

const settingsWithoutCredentials = {
  instagramAccountId: null,
  facebookPageId: null,
  instagramAccessToken: null,
  facebookPageToken: null,
  instagramUsername: '@historico',
  sidebarConfig: { showInstagram: true },
}

const historicalInstagramLead = {
  platform: 'instagram',
  source: 'instagram_direct',
}

const db = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => {
        if (failSidebarLookup) throw new Error('banco indisponível')
        if (table === schema.settings) return Promise.resolve([settingsWithoutCredentials])
        if (table === schema.recoveryLeads) return { limit: async () => [historicalInstagramLead] }
        if (table === schema.instagramCommentAutomations) return { limit: async () => [] }
        throw new Error('Tabela inesperada no teste')
      },
    }),
  }),
}

let inboxLoads = 0
let failSidebarLookup = false

mock.module('@/lib/db', { namedExports: { db } })
mock.module('@/lib/auth', { namedExports: { requireCompany: async () => ({ id: 88 }) } })
mock.module('@/lib/inbox-conversations', {
  namedExports: {
    loadInboxPage: async () => {
      inboxLoads++
      return { conversations: [], nextCursor: null, hasMore: false }
    },
  },
})
mock.module('@/components/inbox/ConversationList', {
  namedExports: { ConversationList: () => null },
})
mock.module('next/navigation', {
  namedExports: {
    redirect: (href: string): never => {
      throw new Error(`NEXT_REDIRECT:${href}`)
    },
  },
})

async function main() {
  const { getCompanySidebarData, hasInstagramCredentials, hasFacebookPageCredentials, getFacebookPageCredentialError } = await import('../src/lib/company-sidebar')
  const { default: InstagramLayout } = await import('../src/app/(dashboard)/instagram/layout')

  await test('B2: histórico Instagram sem credencial não ativa conexão nem acessa /instagram', async () => {
    const sidebar = await getCompanySidebarData(88)
    assert.equal(sidebar.activeConnections.instagram, false)
    assert.equal(sidebar.activeConnections.instagramCommentAutomation, false)

    await assert.rejects(
      () => InstagramLayout({ children: null }),
      /NEXT_REDIRECT:\/inbox/,
    )
    assert.equal(inboxLoads, 0, 'o layout deve redirecionar antes de carregar conversas')
  })

  await test('gate exige identificador e token, aceitando os pares usados pelo transporte', () => {
    assert.equal(hasInstagramCredentials(settingsWithoutCredentials), false)
    assert.equal(hasInstagramCredentials({
      instagramAccountId: 'ig-account',
      facebookPageId: null,
      instagramAccessToken: null,
      facebookPageToken: null,
    }), false)
    assert.equal(hasInstagramCredentials({
      instagramAccountId: null,
      facebookPageId: null,
      instagramAccessToken: 'token-sem-conta',
      facebookPageToken: null,
    }), false)
    assert.equal(hasInstagramCredentials({
      instagramAccountId: 'ig-account',
      facebookPageId: null,
      instagramAccessToken: 'ig-token',
      facebookPageToken: null,
    }), true)
    assert.equal(hasInstagramCredentials({
      instagramAccountId: null,
      facebookPageId: 'page-id',
      instagramAccessToken: null,
      facebookPageToken: 'page-token',
    }), false)
    assert.equal(hasFacebookPageCredentials({
      instagramAccountId: null,
      facebookPageId: null,
      instagramAccessToken: null,
      facebookPageToken: 'page-token',
    }), false)
    assert.equal(hasFacebookPageCredentials({
      instagramAccountId: null,
      facebookPageId: 'page-id',
      instagramAccessToken: null,
      facebookPageToken: 'page-token',
    }), true)
    assert.equal(getFacebookPageCredentialError({ instagramAccountId: null, instagramAccessToken: null, facebookPageId: null, facebookPageToken: null }), 'Página do Facebook exige Page ID e Page Token.')
    assert.equal(getFacebookPageCredentialError({ instagramAccountId: null, instagramAccessToken: null, facebookPageId: 'page-id', facebookPageToken: null }), 'Página do Facebook exige Page Token.')
    assert.equal(getFacebookPageCredentialError({ instagramAccountId: null, instagramAccessToken: null, facebookPageId: 'page-id', facebookPageToken: 'page-token' }), null)
  })

  await test('preferência visual não reativa Instagram sem conexão operacional', async () => {
    const sidebar = await getCompanySidebarData(88)
    assert.equal(sidebar.sidebarConfig?.showInstagram, true)
    assert.equal(sidebar.activeConnections.instagram, false)
  })

  await test('falha ao consultar configurações fecha canais, inclusive Hotmart', async () => {
    failSidebarLookup = true
    try {
      const sidebar = await getCompanySidebarData(88)
      assert.equal(sidebar.activeConnections.hotmart, false)
      assert.equal(sidebar.activeConnections.instagram, false)
    } finally {
      failSidebarLookup = false
    }
  })
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
