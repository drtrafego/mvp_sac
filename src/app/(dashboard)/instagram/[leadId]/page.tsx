export const dynamic = 'force-dynamic'

import { ConversationChatPage } from '@/components/inbox/ConversationChatPage'

export default async function InstagramChatPage({ params, searchParams }: { params: Promise<{ leadId: string }>; searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { leadId } = await params
  return <ConversationChatPage leadId={leadId} backHref="/instagram" requiredChannel="instagram" searchParams={searchParams} />
}
