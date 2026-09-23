export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, desc, and, or, inArray } from 'drizzle-orm'
import { channelWhereCondition } from '@/lib/inbox-channel-filter'

type Params = { params: Promise<{ idOrSlug: string }> }

function last8(phone: string | null | undefined): string {
  const digits = (phone || '').replace(/\D/g, '')
  return digits.length >= 8 ? digits.slice(-8) : digits
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const companyId = context.company.id

  // Sem parâmetro = mesmo comportamento de sempre (todos os canais). Passar
  // ?channel=email|whatsapp|instagram|mineracao|mineracao_email|mineracao_whatsapp|mineracao_instagram|anuncio|anuncio_meta_ads|anuncio_google_ads
  // filtra no WHERE, mesma heurística usada no inbox interno.
  const { searchParams } = new URL(req.url)
  const channelParam = searchParams.get('channel')?.trim().toLowerCase() || undefined
  const channelCondition = channelWhereCondition(channelParam)

  const leads = await db
    .select({
      id: recoveryLeads.id,
      phone: recoveryLeads.phone,
      name: recoveryLeads.name,
      email: recoveryLeads.email,
      eventType: recoveryLeads.eventType,
      status: recoveryLeads.status,
      pipelineStage: recoveryLeads.pipelineStage,
      productName: recoveryLeads.productName,
      productValue: recoveryLeads.productValue,
      platform: recoveryLeads.platform,
      channel: recoveryLeads.channel,
      botPaused: recoveryLeads.botPaused,
      trackingSource: recoveryLeads.trackingSource,
      utmCampaign: recoveryLeads.utmCampaign,
      adsetName: recoveryLeads.adsetName,
      adName: recoveryLeads.adName,
      createdAt: recoveryLeads.createdAt,
    })
    .from(recoveryLeads)
    .where(
      channelCondition ? and(eq(recoveryLeads.companyId, companyId), channelCondition) : eq(recoveryLeads.companyId, companyId)
    )
    .orderBy(desc(recoveryLeads.updatedAt))
    .limit(250)

  const leadIds = leads.map(l => l.id)
  const phones = leads.map(l => l.phone).filter(Boolean)

  // Uma única query em lote, indexada por company_id, em vez de 3 subqueries
  // correlacionadas por lead (com regexp nos dois lados, não indexável).
  // Usa inArray (gera "IN (...)"), não ANY(${array}): o sql`` do drizzle
  // expande um array interpolado em "(p1, p2, ...)" — um ANY() em volta disso
  // vira "ANY((1, 2, 3))", que o Postgres rejeita com "op ANY/ALL (array)
  // requires array on right side". IN (...) aceita essa mesma expansão.
  const messages = leads.length === 0 ? [] : await db
    .select({
      id: whatsappMessages.id,
      leadId: whatsappMessages.leadId,
      phone: whatsappMessages.phone,
      direction: whatsappMessages.direction,
      content: whatsappMessages.content,
      createdAt: whatsappMessages.createdAt,
    })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.companyId, companyId),
        or(inArray(whatsappMessages.leadId, leadIds), inArray(whatsappMessages.phone, phones))
      )
    )
    .orderBy(desc(whatsappMessages.createdAt))
    .limit(1000)

  // Join em memória: por lead_id exato, por telefone exato e por fallback
  // dos últimos 8 dígitos (cobre diferença de DDI/formatação entre origens).
  const byLeadId = new Map<number, typeof messages>()
  const byPhone = new Map<string, typeof messages>()
  const byLast8 = new Map<string, typeof messages>()
  for (const m of messages) {
    if (m.leadId) {
      if (!byLeadId.has(m.leadId)) byLeadId.set(m.leadId, [])
      byLeadId.get(m.leadId)!.push(m)
    }
    if (m.phone) {
      if (!byPhone.has(m.phone)) byPhone.set(m.phone, [])
      byPhone.get(m.phone)!.push(m)
      const l8 = last8(m.phone)
      if (l8) {
        if (!byLast8.has(l8)) byLast8.set(l8, [])
        byLast8.get(l8)!.push(m)
      }
    }
  }

  const withMessages = leads.map(l => {
    const candidates =
      (l.id ? byLeadId.get(l.id) : undefined) ||
      (l.phone ? byPhone.get(l.phone) : undefined) ||
      (l.phone ? byLast8.get(last8(l.phone)) : undefined) ||
      []
    const lastMsg = candidates[0] ?? null // já vem ordenado desc por created_at
    const unread = candidates.filter(m => m.direction === 'inbound').length
    return {
      ...l,
      lastMessage: lastMsg?.content ?? null,
      lastMessageAt: lastMsg?.createdAt ? lastMsg.createdAt.toISOString() : null,
      unread,
    }
  })

  // Deduplicação e consolidação por pessoa
  const personMap = new Map<string, (typeof withMessages)[number]>()
  for (const c of withMessages) {
    const rawDigits = (c.phone || '').replace(/\D/g, '')
    const key = rawDigits.length >= 9
      ? `phone_${rawDigits.slice(-9)}`
      : c.email
      ? `email_${c.email.toLowerCase().trim()}`
      : `raw_${c.phone}`

    const existing = personMap.get(key)
    if (!existing) {
      personMap.set(key, { ...c })
    } else {
      const existingTime = existing.lastMessageAt ? new Date(existing.lastMessageAt).getTime() : 0
      const currentTime = c.lastMessageAt ? new Date(c.lastMessageAt).getTime() : 0
      const totalUnread = (existing.unread || 0) + (c.unread || 0)

      if (currentTime > existingTime) {
        personMap.set(key, { ...c, unread: totalUnread, name: c.name || existing.name })
      } else {
        existing.unread = totalUnread
        if (!existing.name && c.name) existing.name = c.name
      }
    }
  }

  const conversations = Array.from(personMap.values()).sort((a, b) => {
    const timeA = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
    const timeB = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
    return timeB - timeA
  })

  return NextResponse.json({
    ok: true,
    company: { id: context.company.id, slug: context.company.slug },
    count: conversations.length,
    conversations,
  })
}
