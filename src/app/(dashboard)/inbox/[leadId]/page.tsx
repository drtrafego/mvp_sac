export const dynamic = 'force-dynamic'

import { ConversationChatPage } from '@/components/inbox/ConversationChatPage'

export default async function InboxChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ leadId: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const { leadId } = await params
  return <ConversationChatPage leadId={leadId} backHref="/inbox" searchParams={searchParams} />
}
