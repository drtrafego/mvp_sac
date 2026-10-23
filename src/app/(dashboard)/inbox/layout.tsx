export const dynamic = 'force-dynamic'

import { ConversationList } from '@/components/inbox/ConversationList'
import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { loadInboxPage, type InboxPage } from '@/lib/inbox-conversations'
import { includesInstagramInGeneral } from '@/lib/instagram-inbox-placement'

export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const company = await requireCompany()
  const [companySettings] = await db
    .select({ instagramInboxPlacement: settings.instagramInboxPlacement })
    .from(settings)
    .where(eq(settings.companyId, company.id))
    .limit(1)
  let page: InboxPage = { conversations: [], nextCursor: null, hasMore: false }
  let error: string | null = null
  try {
    page = await loadInboxPage({
      companyId: company.id,
      includeInstagramInGeneral: includesInstagramInGeneral(companySettings?.instagramInboxPlacement),
    })
  } catch (err) {
    console.error('[Inbox layout loadInboxPage error]:', err)
    error = 'Falha ao carregar as conversas do banco de dados.'
  }

  return (
    <div className="flex flex-1 min-h-0 h-full w-full overflow-hidden bg-surface-base">
      <ConversationList
        initial={page.conversations}
        initialCursor={page.nextCursor}
        initialHasMore={page.hasMore}
        initialError={error}
      />
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col h-full bg-surface-base">{children}</div>
    </div>
  )
}
