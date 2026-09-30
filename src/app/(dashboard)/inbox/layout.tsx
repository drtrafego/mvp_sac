export const dynamic = 'force-dynamic'

import { ConversationList } from '@/components/inbox/ConversationList'
import { requireCompany } from '@/lib/auth'
import { loadInboxPage, type InboxPage } from '@/lib/inbox-conversations'
import { getCompanySidebarData } from '@/lib/company-sidebar'

export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const company = await requireCompany()
  let page: InboxPage = { conversations: [], nextCursor: null, hasMore: false }
  let error: string | null = null
  try {
    page = await loadInboxPage({ companyId: company.id })
  } catch (err) {
    console.error('[Inbox layout loadInboxPage error]:', err)
    error = 'Falha ao carregar as conversas do banco de dados.'
  }

  // Mesmo flag que já esconde a seção "Instagram" inteira do menu lateral
  // (src/app/(dashboard)/layout.tsx → Sidebar activeConnections.instagram).
  // Sem isto o chip "Direct" do seletor de canal aparecia pra QUALQUER
  // empresa, mesmo uma sem Instagram configurado, enquanto o link "Conversas
  // Direct" que levaria a este mesmo canal já não existia pra ela no menu.
  const { activeConnections } = await getCompanySidebarData(company.id)

  return (
    <div className="flex flex-1 min-h-0 h-full w-full overflow-hidden bg-surface-base">
      <ConversationList
        initial={page.conversations}
        initialCursor={page.nextCursor}
        initialHasMore={page.hasMore}
        initialError={error}
        showInstagramChannel={activeConnections.instagram}
      />
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col h-full bg-surface-base">{children}</div>
    </div>
  )
}
