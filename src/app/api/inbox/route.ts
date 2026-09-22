export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { desc, eq, sql, and, inArray } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { channelWhereCondition, matchesPhoneSearch } from '@/lib/inbox-channel-filter'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const { searchParams } = new URL(req.url)

  const chFilter = searchParams.get('channel') // all | whatsapp | instagram | email | mineracao | mineracao_email | mineracao_whatsapp | mineracao_instagram | anuncio | anuncio_meta_ads | anuncio_google_ads
  const statusFilter = searchParams.get('status') // all | paused | active
  const q = searchParams.get('q')?.trim()

  // Filtro de canal precisa entrar no WHERE, antes do LIMIT: filtrar depois
  // (em memória, sobre os 200 já cortados por atividade recente) é o que
  // fazia o WhatsApp de alta recorrência engolir as vagas e some e-mail
  // recém-criado da lista mesmo estando salvo certo no banco.
  const channelCondition = channelWhereCondition(chFilter)

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
    })
    .from(recoveryLeads)
    .where(
      channelCondition
        ? and(eq(recoveryLeads.companyId, company.id), channelCondition)
        : eq(recoveryLeads.companyId, company.id)
    )
    .orderBy(desc(sql`COALESCE(${recoveryLeads.lastActionAt}, ${recoveryLeads.updatedAt}, ${recoveryLeads.createdAt})`))
  // Sem .limit(): ordem explícita do Gastão ("não quero limite"). A AutonomIA
  // sozinha já passa de 2.400 leads e o corte em 200 escondia tudo que vinha
  // depois. Ver comentário grande abaixo sobre como isso muda a busca de
  // mensagens (não dá mais pra confiar num LIMIT fixo de mensagens recentes).

  if (leads.length === 0) return NextResponse.json([])

  const leadIds = leads.map(l => l.id)
  const phones = leads.map(l => l.phone).filter((p): p is string => Boolean(p && p.trim()))

  // Última mensagem de CADA lead via DISTINCT ON (Postgres), não mais um
  // LIMIT fixo de mensagens recentes da empresa inteira: com 200 leads na
  // tela, "pegar as 500 mensagens mais recentes da empresa e ficar com a
  // primeira ocorrência de cada lead" cobria o caso na prática. Sem limite de
  // leads (podem ser milhares), 500 mensagens não bate nem perto de 1 por
  // lead, e lead mais antigo ficava sem lastMessage mesmo tendo conversa de
  // verdade. DISTINCT ON (lead_id) / DISTINCT ON (phone) devolve exatamente 1
  // linha (a mais recente) por chave, não importa quantos leads existam, e o
  // resultado fica limitado ao tamanho de leadIds/phones, não ao total de
  // mensagens da empresa.
  //
  // Duas consultas, não uma: preserva a MESMA prioridade de antes
  // (msgByLead primeiro, msgByPhone só como fallback pra mensagem antiga sem
  // lead_id vinculado), sem misturar as duas semânticas numa DISTINCT ON só.
  const lastMessageByLeadId = await db
    .selectDistinctOn([whatsappMessages.leadId], {
      leadId: whatsappMessages.leadId,
      direction: whatsappMessages.direction,
      content: whatsappMessages.content,
      createdAt: whatsappMessages.createdAt,
    })
    .from(whatsappMessages)
    .where(and(eq(whatsappMessages.companyId, company.id), inArray(whatsappMessages.leadId, leadIds)))
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
        .where(and(eq(whatsappMessages.companyId, company.id), inArray(whatsappMessages.phone, phones)))
        .orderBy(whatsappMessages.phone, desc(whatsappMessages.createdAt))
    : []

  // Contagem de "não lida" por lead: não existe coluna de leitura no schema,
  // sempre foi "quantas mensagens inbound esse lead tem" (ver histórico desta
  // rota). Antes vinha de graça contando o array de 500 mensagens; sem esse
  // array, é um COUNT/GROUP BY dedicado, escopado só aos leads da tela (não
  // a mensagens da empresa inteira), então não cresce com o tamanho da
  // empresa, só com o tamanho da página de leads.
  const unreadRows = await db
    .select({
      leadId: whatsappMessages.leadId,
      count: sql<number>`count(*)::int`,
    })
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.companyId, company.id),
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

  let mapped = leads.map(l => {
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
    }
  })

  // Canal já filtrado no WHERE acima (channelWhereCondition). Status e busca
  // seguem em memória: operam sobre o resultado já correto por canal.
  if (statusFilter && statusFilter !== 'all') {
    if (statusFilter === 'paused') {
      mapped = mapped.filter(l => l.botPaused === true)
    } else if (statusFilter === 'active') {
      mapped = mapped.filter(l => !l.botPaused)
    }
  }

  if (q) {
    const term = q.toLowerCase()
    mapped = mapped.filter(
      l =>
        l.name?.toLowerCase().includes(term) ||
        matchesPhoneSearch(l.phone, term) ||
        l.email?.toLowerCase().includes(term) ||
        l.lastMessage?.toLowerCase().includes(term) ||
        l.productName?.toLowerCase().includes(term)
    )
  }

  return NextResponse.json(mapped)
}
