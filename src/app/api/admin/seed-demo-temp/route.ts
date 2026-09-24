import { NextResponse } from 'next/server'
import { requireAdmin, unauthorizedResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { companies, recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

// Rota TEMPORÁRIA (24/09/2026): seed de conversas encenadas pra empresa DEMO
// (id fixo abaixo), pedido do Gastão pra gravar vídeo de marketing do SAC.
// Nenhum dado real de cliente. Roda só uma vez, remove depois de usar.
const DEMO_COMPANY_SLUG = 'demo-sac'

type SeedConvo = {
  channel: 'whatsapp' | 'instagram' | 'email'
  name: string
  phone: string
  email?: string
  inbound: string
  outbound: string
  at: string // ISO
  replyDelayMin: number
  pipelineStage?: string
  trackingSource?: string
  metaCampaignId?: string
  metaAdsetId?: string
  metaAdId?: string
}

const CONVERSAS: SeedConvo[] = [
  {
    channel: 'whatsapp',
    name: 'Cliente Demo (WhatsApp)',
    phone: 'demo_5511900000001',
    inbound: 'Quanto custa?',
    outbound: 'Oi! Nosso plano começa em R$ 297/mês, com 7 dias grátis pra testar. Quer que eu te mande o link?',
    at: '2026-09-23T23:07:00-03:00',
    replyDelayMin: 2,
  },
  {
    channel: 'instagram',
    name: 'Cliente Demo (Instagram)',
    phone: 'demo_ig_00000002',
    inbound: 'Tem pra amanhã?',
    outbound: 'Temos sim! Amanhã tenho horário às 14h e às 17h. Qual prefere?',
    at: '2026-09-23T23:12:00-03:00',
    replyDelayMin: 1,
  },
  {
    channel: 'email',
    name: 'Cliente Demo (E-mail)',
    phone: 'demo_email_00000003',
    email: 'cliente.demo3@exemplo.com',
    inbound: 'Me manda um orçamento, por favor.',
    outbound: 'Claro! Segue nosso orçamento em anexo. Qualquer dúvida, estou à disposição.',
    at: '2026-09-23T08:40:00-03:00',
    replyDelayMin: 15,
  },
  {
    channel: 'whatsapp',
    name: 'Cliente Demo (Anúncio)',
    phone: 'demo_5511900000004',
    inbound: 'Vi o anúncio de vocês, quero agendar uma demonstração.',
    outbound: 'Perfeito! Vamos agendar sua demonstração. Que tal amanhã às 10h?',
    at: '2026-09-23T10:15:00-03:00',
    replyDelayMin: 3,
    pipelineStage: 'agendado',
    trackingSource: 'meta_ads',
    metaCampaignId: 'demo_campanha_recuperacao',
    metaAdsetId: 'demo_conjunto_topo',
    metaAdId: 'demo_anuncio_video_01',
  },
  {
    channel: 'instagram',
    name: 'Cliente Demo (Dúvida)',
    phone: 'demo_ig_00000005',
    inbound: 'Como funciona a integração com o WhatsApp?',
    outbound: 'Ótima pergunta! Conectamos direto com o WhatsApp oficial da Meta, sem precisar trocar de número.',
    at: '2026-09-23T14:30:00-03:00',
    replyDelayMin: 2,
  },
  {
    channel: 'whatsapp',
    name: 'Cliente Demo (Encerramento)',
    phone: 'demo_5511900000006',
    inbound: 'Obrigado pelo atendimento, vou pensar com calma.',
    outbound: 'Imagina, fico à disposição! Qualquer dúvida é só chamar por aqui. 😊',
    at: '2026-09-23T16:50:00-03:00',
    replyDelayMin: 1,
  },
]

type SeedEvent = {
  platform: string
  eventType: string
  name: string
  phone: string
  email?: string
  productName?: string
  productValue?: number
  status?: string
  boletoCode?: string
  boletoUrl?: string
  boletoExpiryDays?: number
  pixCode?: string
  pixExpiryMinutes?: number
  checkoutUrl?: string
  paymentType?: string
  channel?: string
  trackingSource?: string
  miningTags?: { origem?: string; nicho?: string; temperatura?: string }
  at: string
}

const EVENTOS: SeedEvent[] = [
  {
    platform: 'hotmart',
    eventType: 'boleto',
    name: 'Cliente Demo (Boleto)',
    phone: 'demo_5511900000007',
    productName: 'Curso Avançado de Marketing',
    productValue: 49700,
    boletoCode: '34191.79001 01043.510047 91020.150008 1 96380000049700',
    boletoUrl: 'https://exemplo.com/boleto/demo',
    boletoExpiryDays: 3,
    at: '2026-09-23T09:20:00-03:00',
  },
  {
    platform: 'kiwify',
    eventType: 'pix',
    name: 'Cliente Demo (Pix)',
    phone: 'demo_5511900000008',
    productName: 'Mentoria VIP',
    productValue: 97000,
    pixCode: '00020126580014BR.GOV.BCB.PIX0136demo-pix-000000000000005204000053039865802BR',
    pixExpiryMinutes: 30,
    at: '2026-09-23T11:05:00-03:00',
  },
  {
    platform: 'greenn',
    eventType: 'carrinho_abandonado',
    name: 'Cliente Demo (Carrinho)',
    phone: 'demo_5511900000009',
    productName: 'Ebook Estratégias de Tráfego',
    productValue: 9700,
    checkoutUrl: 'https://checkout.exemplo.com/demo-carrinho',
    at: '2026-09-23T13:45:00-03:00',
  },
  {
    platform: 'zouti',
    eventType: 'cartao_recusado',
    name: 'Cliente Demo (Cartão Recusado)',
    phone: 'demo_5511900000010',
    productName: 'Assinatura Anual',
    productValue: 199700,
    paymentType: 'credit_card',
    at: '2026-09-23T15:30:00-03:00',
  },
  {
    platform: 'hotmart',
    eventType: 'compra_aprovada',
    name: 'Cliente Demo (Venda)',
    phone: 'demo_5511900000011',
    productName: 'Curso Avançado de Marketing',
    productValue: 49700,
    status: 'converted',
    at: '2026-09-23T17:10:00-03:00',
  },
  {
    platform: 'sac',
    eventType: 'atendimento',
    name: 'Cliente Demo (Mineração 1)',
    phone: 'demo_5511900000012',
    channel: 'mineracao',
    trackingSource: 'Minerador',
    miningTags: { origem: 'google_places', nicho: 'Estética', temperatura: 'hot' },
    at: '2026-09-23T09:50:00-03:00',
  },
  {
    platform: 'sac',
    eventType: 'atendimento',
    name: 'Cliente Demo (Mineração 2)',
    phone: 'demo_5511900000013',
    channel: 'mineracao',
    trackingSource: 'Minerador',
    miningTags: { origem: 'instagram', nicho: 'Odontologia', temperatura: 'warm' },
    at: '2026-09-23T18:20:00-03:00',
  },
]

export async function POST() {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const [company] = await db.select().from(companies).where(eq(companies.slug, DEMO_COMPANY_SLUG)).limit(1)
  if (!company) {
    return NextResponse.json({ error: `Empresa "${DEMO_COMPANY_SLUG}" não encontrada. Crie antes de rodar o seed.` }, { status: 404 })
  }

  const created: { leadId: number; name: string }[] = []
  const skipped: string[] = []

  for (const convo of CONVERSAS) {
    const [existing] = await db.select({ id: recoveryLeads.id }).from(recoveryLeads)
      .where(and(eq(recoveryLeads.companyId, company.id), eq(recoveryLeads.phone, convo.phone))).limit(1)
    if (existing) { skipped.push(convo.name); continue }

    const inboundAt = new Date(convo.at)
    const outboundAt = new Date(inboundAt.getTime() + convo.replyDelayMin * 60_000)

    const [lead] = await db
      .insert(recoveryLeads)
      .values({
        companyId: company.id,
        platform: 'sac',
        channel: convo.channel,
        eventType: 'atendimento',
        phone: convo.phone,
        name: convo.name,
        email: convo.email ?? null,
        status: 'in_conversation',
        pipelineStage: convo.pipelineStage ?? null,
        trackingSource: convo.trackingSource ?? null,
        metaCampaignId: convo.metaCampaignId ?? null,
        metaAdsetId: convo.metaAdsetId ?? null,
        metaAdId: convo.metaAdId ?? null,
        createdAt: inboundAt,
        updatedAt: outboundAt,
        lastActionAt: outboundAt,
      })
      .returning()

    await db.insert(whatsappMessages).values([
      {
        companyId: company.id,
        leadId: lead!.id,
        phone: convo.phone,
        channel: convo.channel,
        direction: 'inbound',
        content: convo.inbound,
        messageType: 'text',
        sentBy: 'user',
        createdAt: inboundAt,
      },
      {
        companyId: company.id,
        leadId: lead!.id,
        phone: convo.phone,
        channel: convo.channel,
        direction: 'outbound',
        content: convo.outbound,
        messageType: 'text',
        sentBy: 'bot',
        createdAt: outboundAt,
      },
    ])

    created.push({ leadId: lead!.id, name: convo.name })
  }

  for (const ev of EVENTOS) {
    const [existing] = await db.select({ id: recoveryLeads.id }).from(recoveryLeads)
      .where(and(eq(recoveryLeads.companyId, company.id), eq(recoveryLeads.phone, ev.phone))).limit(1)
    if (existing) { skipped.push(ev.name); continue }

    const at = new Date(ev.at)
    const [lead] = await db
      .insert(recoveryLeads)
      .values({
        companyId: company.id,
        platform: ev.platform,
        channel: ev.channel ?? 'whatsapp',
        eventType: ev.eventType,
        phone: ev.phone,
        name: ev.name,
        email: ev.email ?? null,
        productName: ev.productName ?? null,
        productValue: ev.productValue ?? null,
        status: ev.status ?? 'pending',
        boletoCode: ev.boletoCode ?? null,
        boletoUrl: ev.boletoUrl ?? null,
        boletoExpiry: ev.boletoExpiryDays ? new Date(at.getTime() + ev.boletoExpiryDays * 86_400_000) : null,
        pixCode: ev.pixCode ?? null,
        pixExpiry: ev.pixExpiryMinutes ? new Date(at.getTime() + ev.pixExpiryMinutes * 60_000) : null,
        checkoutUrl: ev.checkoutUrl ?? null,
        paymentType: ev.paymentType ?? null,
        trackingSource: ev.trackingSource ?? null,
        miningTags: ev.miningTags ?? null,
        orderDate: at,
        approvedDate: ev.eventType === 'compra_aprovada' ? at : null,
        createdAt: at,
        updatedAt: at,
        lastActionAt: at,
      })
      .returning()

    created.push({ leadId: lead!.id, name: ev.name })
  }

  return NextResponse.json({ ok: true, companyId: company.id, created, skipped })
}
