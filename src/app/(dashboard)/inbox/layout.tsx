export const dynamic = 'force-dynamic'

import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { desc, eq, and, inArray, sql } from 'drizzle-orm'
import { ConversationList, type ConversationSummary } from '@/components/inbox/ConversationList'
import { requireCompany } from '@/lib/auth'
import { getEmailEngagement } from '@/lib/email-engagement'

async function getConversations(companyId: number): Promise<{ conversations: ConversationSummary[]; error: string | null }> {
  try {
    const leads = await db
      .select({
        id: recoveryLeads.id,
        phone: recoveryLeads.phone,
        name: recoveryLeads.name,
        email: recoveryLeads.email,
        eventType: recoveryLeads.eventType,
        status: recoveryLeads.status,
        productName: recoveryLeads.productName,
        productValue: recoveryLeads.productValue,
        platform: recoveryLeads.platform,
        channel: recoveryLeads.channel,
        botPaused: recoveryLeads.botPaused,
        botPausedAt: recoveryLeads.botPausedAt,
        botPausedBy: recoveryLeads.botPausedBy,
        trackingSource: recoveryLeads.trackingSource,
        utmCampaign: recoveryLeads.utmCampaign,
        createdAt: recoveryLeads.createdAt,
        updatedAt: recoveryLeads.updatedAt,
        lastActionAt: recoveryLeads.lastActionAt,
        miningTags: recoveryLeads.miningTags,
      })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.companyId, companyId))
      .orderBy(desc(sql`COALESCE(${recoveryLeads.lastActionAt}, ${recoveryLeads.updatedAt}, ${recoveryLeads.createdAt})`))
    // Sem .limit(): mesma ordem do Gastão aplicada em src/app/api/inbox/route.ts
    // ("não quero limite"). Este layout é a primeira renderização da lista
    // (useState inicial do ConversationList, depois só recebe atualização via
    // fetch em /api/inbox), então precisa do mesmo tratamento ou o primeiro
    // paint já vem cortado em 200.

    if (leads.length === 0) return { conversations: [], error: null }

    const leadIds = leads.map(l => l.id)
    const phones = leads.map(l => l.phone).filter((p): p is string => Boolean(p && p.trim()))

    // Última mensagem de CADA lead via DISTINCT ON, não LIMIT fixo sobre a
    // empresa inteira. Mesmo motivo e mesmo desenho de src/app/api/inbox/route.ts:
    // sem limite de leads, um corte de mensagens recentes da empresa não cobre
    // mais 1 mensagem por lead, e lead antigo ficava sem lastMessage.
    const lastMessageByLeadId = await db
      .selectDistinctOn([whatsappMessages.leadId], {
        leadId: whatsappMessages.leadId,
        direction: whatsappMessages.direction,
        content: whatsappMessages.content,
        createdAt: whatsappMessages.createdAt,
      })
      .from(whatsappMessages)
      .where(and(eq(whatsappMessages.companyId, companyId), inArray(whatsappMessages.leadId, leadIds)))
      .orderBy(whatsappMessages.leadId, desc(whatsappMessages.createdAt))

    const lastMessageByPhone = phones.length > 0
      ? await db
          .selectDistinctOn([whatsappMessages.phone], {
            phone: whatsappMessages.phone,
            direction: whatsappMessages.direction,
            content: whatsappMessages.content,
            createdAt: whatsappMessages.createdAt,
          })
          .from(whatsappMessages)
          .where(and(eq(whatsappMessages.companyId, companyId), inArray(whatsappMessages.phone, phones)))
          .orderBy(whatsappMessages.phone, desc(whatsappMessages.createdAt))
      : []

    // Contagem de "não lida" por lead (ver comentário irmão em
    // src/app/api/inbox/route.ts): COUNT/GROUP BY dedicado escopado aos leads
    // da tela, não mais um subproduto do array de mensagens recentes.
    const unreadRows = await db
      .select({
        leadId: whatsappMessages.leadId,
        count: sql<number>`count(*)::int`,
      })
      .from(whatsappMessages)
      .where(
        and(
          eq(whatsappMessages.companyId, companyId),
          eq(whatsappMessages.direction, 'inbound'),
          inArray(whatsappMessages.leadId, leadIds)
        )
      )
      .groupBy(whatsappMessages.leadId)

    const msgByLead = new Map<number, typeof lastMessageByLeadId[0]>()
    const msgByPhone = new Map<string, typeof lastMessageByPhone[0]>()
    const unreadCountByLead = new Map<number, number>()

    for (const m of lastMessageByLeadId) {
      if (m.leadId != null) msgByLead.set(m.leadId, m)
    }
    for (const m of lastMessageByPhone) {
      if (m.phone) msgByPhone.set(m.phone, m)
    }
    for (const r of unreadRows) {
      if (r.leadId != null) unreadCountByLead.set(r.leadId, r.count)
    }

    const mapped: ConversationSummary[] = leads.map(l => {
      const lastMsg = (l.id ? msgByLead.get(l.id) : null) || (l.phone ? msgByPhone.get(l.phone) : null)
      return {
        id: l.id,
        phone: l.phone,
        name: l.name,
        email: l.email,
        eventType: l.eventType,
        status: l.status,
        productName: l.productName,
        productValue: l.productValue,
        platform: l.platform,
        channel: l.channel || 'whatsapp',
        botPaused: l.botPaused ?? false,
        botPausedAt: l.botPausedAt ? l.botPausedAt.toISOString() : null,
        botPausedBy: l.botPausedBy,
        trackingSource: l.trackingSource,
        utmCampaign: l.utmCampaign,
        createdAt: l.createdAt ? l.createdAt.toISOString() : null,
        lastMessage: lastMsg?.content ?? null,
        lastDirection: lastMsg?.direction ?? null,
        lastMessageAt: lastMsg?.createdAt ? lastMsg.createdAt.toISOString() : (l.updatedAt ? l.updatedAt.toISOString() : null),
        lastInboundAt: lastMsg?.direction === 'inbound' && lastMsg.createdAt ? lastMsg.createdAt.toISOString() : null,
        lastOutboundAt: lastMsg?.direction === 'outbound' && lastMsg.createdAt ? lastMsg.createdAt.toISOString() : null,
        unread: unreadCountByLead.get(l.id) || 0,
        emailEngagement: getEmailEngagement(l.miningTags),
      }
    })

    return { conversations: mapped, error: null }
  } catch (err: any) {
    console.error('[Inbox layout getConversations error]:', err)
    return { conversations: [], error: 'Falha ao carregar as conversas do banco de dados.' }
  }
}

export default async function InboxLayout({ children }: { children: React.ReactNode }) {
  const company = await requireCompany()
  const { conversations, error } = await getConversations(company.id)

  return (
    <div className="flex flex-1 min-h-0 h-full w-full overflow-hidden bg-surface-base">
      <ConversationList initial={conversations} initialError={error} />
      <div className="flex-1 min-w-0 overflow-hidden flex flex-col h-full bg-surface-base">{children}</div>
    </div>
  )
}
