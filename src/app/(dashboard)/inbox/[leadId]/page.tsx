export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { eq, asc, and, or, sql } from 'drizzle-orm'
import { ChatWindow } from '@/components/inbox/ChatWindow'
import { requireCompany } from '@/lib/auth'
import { queryAgentsDb } from '@/lib/db/agents-db'

export default async function InboxChatPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id)) notFound()

  const company = await requireCompany()

  const [lead] = await db
    .select()
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))

  if (!lead) notFound()

  const cleanPhone = (lead.phone || '').replace(/\D/g, '')

  // 1. Busca mensagens no banco local com matching flexível
  let messages = await db
    .select()
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.companyId, company.id),
        or(
          eq(whatsappMessages.leadId, id),
          eq(whatsappMessages.phone, lead.phone),
          cleanPhone.length >= 8
            ? sql`length(regexp_replace(${whatsappMessages.phone}, '\\D', '', 'g')) >= 8 AND right(regexp_replace(${whatsappMessages.phone}, '\\D', '', 'g'), 8) = right(${cleanPhone}, 8)`
            : undefined
        )
      )
    )
    .orderBy(asc(whatsappMessages.createdAt))
    .limit(300)

  // 2. Se nenhuma mensagem estiver salva localmente, busca sob demanda no Supabase/Neon de agentes
  if (messages.length === 0) {
    try {
      // (a) Busca em public.outreach_convos e public.outreach_msgs
      const convos = await queryAgentsDb<{ id: string; channel: string | null }>(
        `select id, channel from public.outreach_convos
         where right(regexp_replace(lead_handle, '\\D', '', 'g'), 9) = right($1, 9)
            or lead_handle = $2
         limit 1`,
        [cleanPhone, lead.phone]
      )

      if (convos && convos.length > 0) {
        const convo = convos[0]
        const outreachMsgs = await queryAgentsDb<{
          id: string
          direction: string | null
          status: string | null
          subject: string | null
          body: string | null
          sent_at: string | null
        }>(
          `select id, direction, status, subject, body, sent_at
           from public.outreach_msgs
           where convo_id = $1
           order by sent_at asc`,
          [convo.id]
        )

        if (outreachMsgs && outreachMsgs.length > 0) {
          for (const m of outreachMsgs) {
            const isUser = m.direction === 'inbound'
            const direction = isUser ? 'inbound' : 'outbound'
            const sentBy = isUser ? 'user' : 'bot'
            const externalId = `outreach_${m.id}`

            await db
              .insert(whatsappMessages)
              .values({
                companyId: company.id,
                leadId: lead.id,
                phone: lead.phone,
                channel: lead.channel || convo.channel || 'whatsapp',
                direction,
                content: m.body || m.subject || '',
                messageType: 'text',
                sentBy,
                externalId,
                createdAt: m.sent_at ? new Date(m.sent_at) : new Date(),
              })
              .onConflictDoNothing()
          }
        }
      }

      // (b) Busca nas mensagens de conversas dos schemas dos agentes
      const schemaRows = await queryAgentsDb<{ schema_name: string }>(
        `select schema_name from public.agents where active = true`
      )

      if (schemaRows && schemaRows.length > 0) {
        for (const s of schemaRows) {
          const schema = s.schema_name
          if (!schema) continue
          try {
            const schemaConvs = await queryAgentsDb<{ session_id: string }>(
              `select session_id from "${schema}".conversations
               where right(regexp_replace(chat_id, '\\D', '', 'g'), 9) = right($1, 9)
                  or session_id = $2
               limit 1`,
              [cleanPhone, lead.phone]
            )

            if (schemaConvs && schemaConvs.length > 0) {
              const sessId = schemaConvs[0].session_id
              const schemaMsgs = await queryAgentsDb<{
                id: string | number
                role: string
                content: string | null
                ts: string | null
              }>(
                `select id, role, content, ts from "${schema}".messages
                 where session_id = $1
                 order by ts asc`,
                [sessId]
              )

              if (schemaMsgs && schemaMsgs.length > 0) {
                for (const sm of schemaMsgs) {
                  const isUser = sm.role === 'user'
                  const externalId = `agent_${schema}_${sm.id || sessId + '_' + sm.ts}`
                  await db
                    .insert(whatsappMessages)
                    .values({
                      companyId: company.id,
                      leadId: lead.id,
                      phone: lead.phone,
                      channel: lead.channel || 'whatsapp',
                      direction: isUser ? 'inbound' : 'outbound',
                      content: sm.content || '',
                      messageType: 'text',
                      sentBy: isUser ? 'user' : 'bot',
                      externalId,
                      createdAt: sm.ts ? new Date(sm.ts) : new Date(),
                    })
                    .onConflictDoNothing()
                }
              }
            }
          } catch {
            // Continua para o próximo schema se houver erro
          }
        }
      }

      // Re-consulta mensagens após sync sob demanda
      messages = await db
        .select()
        .from(whatsappMessages)
        .where(
          and(
            eq(whatsappMessages.companyId, company.id),
            or(
              eq(whatsappMessages.leadId, id),
              eq(whatsappMessages.phone, lead.phone),
              cleanPhone.length >= 9
                ? sql`right(regexp_replace(${whatsappMessages.phone}, '\\D', '', 'g'), 9) = right(${cleanPhone}, 9)`
                : undefined
            )
          )
        )
        .orderBy(asc(whatsappMessages.createdAt))
        .limit(300)
    } catch (err) {
      console.error('[Inbox fallback sync error]:', err)
    }
  }

  return (
    <ChatWindow
      lead={{
        id: lead.id,
        phone: lead.phone,
        name: lead.name ?? null,
        email: lead.email ?? null,
        eventType: lead.eventType,
        status: lead.status ?? null,
        productName: lead.productName ?? null,
        productValue: lead.productValue ?? null,
        platform: lead.platform ?? null,
        channel: lead.channel || 'whatsapp',
        botPaused: lead.botPaused ?? false,
        botPausedAt: lead.botPausedAt ? lead.botPausedAt.toISOString() : null,
        botPausedBy: lead.botPausedBy ?? null,
        trackingSource: lead.trackingSource ?? null,
        utmCampaign: lead.utmCampaign ?? null,
        createdAt: lead.createdAt ? lead.createdAt.toISOString() : null,
      }}
      initialMessages={messages.map(m => ({
        id: m.id,
        phone: m.phone,
        channel: m.channel || lead.channel || 'whatsapp',
        direction: m.direction,
        content: m.content ?? null,
        messageType: m.messageType ?? 'text',
        mediaUrl: m.mediaUrl ?? null,
        sentBy: m.sentBy ?? 'human',
        createdAt: m.createdAt?.toISOString() ?? null,
      }))}
    />
  )
}
