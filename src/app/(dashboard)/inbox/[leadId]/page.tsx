export const dynamic = 'force-dynamic'

import { ConversationChatPage } from '@/components/inbox/ConversationChatPage'
import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoveryLeads, settings } from '@/lib/db/schema'
import { includesInstagramInGeneral } from '@/lib/instagram-inbox-placement'
import { isInstagramDelivery } from '@/lib/lead-delivery-channel'

export default async function InboxChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ leadId: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { leadId } = await params
  const id = Number.parseInt(leadId, 10)
  if (Number.isSafeInteger(id) && id > 0) {
    const company = await requireCompany()
    const [[lead], [companySettings]] = await Promise.all([
      db
        .select({ channel: recoveryLeads.channel, phone: recoveryLeads.phone })
        .from(recoveryLeads)
        .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
        .limit(1),
      db
        .select({ instagramInboxPlacement: settings.instagramInboxPlacement })
        .from(settings)
        .where(eq(settings.companyId, company.id))
        .limit(1),
    ])
    if (lead && isInstagramDelivery(lead) && !includesInstagramInGeneral(companySettings?.instagramInboxPlacement)) {
      redirect(`/instagram/${id}`)
    }
  }
  return <ConversationChatPage leadId={leadId} backHref="/inbox" searchParams={searchParams} />
}
