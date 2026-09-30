export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { ConversationList } from '@/components/inbox/ConversationList'
import { requireCompany } from '@/lib/auth'
import { getCompanySidebarData } from '@/lib/company-sidebar'
import { loadInboxPage, type InboxPage } from '@/lib/inbox-conversations'

export default async function InstagramLayout({ children }: { children: React.ReactNode }) {
  const company = await requireCompany()
  const { activeConnections } = await getCompanySidebarData(company.id)

  // A mesma fonte usada para decidir se a navegação Instagram existe também
  // protege acesso direto à rota para empresas sem conexão ativa.
  if (!activeConnections.instagram) redirect('/inbox')

  let page: InboxPage = { conversations: [], nextCursor: null, hasMore: false }
  let error: string | null = null
  try {
    page = await loadInboxPage({ companyId: company.id, channel: 'instagram_direct' })
  } catch (loadError) {
    console.error('[Instagram layout loadInboxPage error]:', loadError)
    error = 'Falha ao carregar as conversas do Instagram Direct.'
  }

  return (
    <div className="flex flex-1 min-h-0 h-full w-full overflow-hidden bg-surface-base">
      <ConversationList
        initial={page.conversations}
        initialCursor={page.nextCursor}
        initialHasMore={page.hasMore}
        initialError={error}
        basePath="/instagram"
        fixedChannel="instagram"
        title="Instagram Direct"
      />
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col h-full bg-surface-base">{children}</div>
    </div>
  )
}
