export const dynamic = 'force-dynamic'

import { ConversationChatPage } from '@/components/inbox/ConversationChatPage'

export default async function InstagramChatPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  return <ConversationChatPage leadId={leadId} backHref="/instagram" requiredChannel="instagram" />
}
