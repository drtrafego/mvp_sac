import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import * as schema from '../src/lib/db/schema'

const settingsWithoutCredentials = {
  instagramAccountId: null,
  instagramPageId: null,
  instagramAccessToken: null,
  metaAccessToken: null,
  instagramUsername: '@historico',
}

const historicalInstagramLead = {
  platform: 'instagram',
  source: 'instagram_direct',
}

const db = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => {
        if (table === schema.settings) return Promise.resolve([settingsWithoutCredentials])
        return { limit: async () => [historicalInstagramLead] }
      },
    }),
  }),
}

let inboxLoads = 0

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
  const { getCompanySidebarData, hasInstagramCredentials } = await import('../src/lib/company-sidebar')
  const { default: InstagramLayout } = await import('../src/app/(dashboard)/instagram/layout')

  await test('B2: histórico Instagram sem credencial não ativa conexão nem acessa /instagram', async () => {
    const sidebar = await getCompanySidebarData(88)
    assert.equal(sidebar.activeConnections.instagram, false)

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
      instagramPageId: null,
      instagramAccessToken: null,
      metaAccessToken: null,
    }), false)
    assert.equal(hasInstagramCredentials({
      instagramAccountId: null,
      instagramPageId: null,
      instagramAccessToken: 'token-sem-conta',
      metaAccessToken: null,
    }), false)
    assert.equal(hasInstagramCredentials({
      instagramAccountId: 'ig-account',
      instagramPageId: null,
      instagramAccessToken: 'ig-token',
      metaAccessToken: null,
    }), true)
    assert.equal(hasInstagramCredentials({
      instagramAccountId: null,
      instagramPageId: 'page-id',
      instagramAccessToken: null,
      metaAccessToken: 'meta-token',
    }), true)
  })
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
