import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, settings, recoverySequences, sequenceMessages, recoveryLeads, messageJobs } from '@/lib/db/schema'
import { eq, and, inArray, desc, sql } from 'drizzle-orm'
import { sendWhatsAppMessage, formatBrazilianPhone } from '@/lib/whatsapp'
import { checkWebhookToken } from '@/lib/webhook-auth'

type SaleMeta = { meta_key?: string; meta_value?: string }

type GreennPayload = {
  event?: string          // saleUpdated | contractUpdated | checkoutAbandoned
  type?: string           // sale | contract | lead
  oldStatus?: string
  currentStatus?: string
  token?: string
  sf_trk?: string | null
  saleMetas?: SaleMeta[]
  product?: {
    id?: string | number
    name?: string
    amount?: number        // em centavos
    method?: string        // CREDIT_CARD | BOLETO | PIX | PAYPAL | DEBIT_CARD
    type?: string          // TRANSACTION | SUBSCRIPTION
  }
  sale?: {
    id?: string | number
    transaction?: string
    installments?: number
    method?: string          // PIX | BOLETO | CREDIT_CARD — método real da transação
    qrcode?: string          // código PIX copia-e-cola
    imgQrcode?: string       // URL da imagem QR Code PIX
    boleto_barcode?: string
    boleto_url?: string
    boleto_expiration_date?: string
    pix_qr_code?: string
    pix_code?: string
    pix_expiration_date?: string
    commission?: number
    affiliate_code?: string
  }
  client?: {
    id?: string | number
    name?: string
    email?: string
    cellphone?: string
    cpf_cnpj?: string
    city?: string
    state?: string
    country?: string
    zipcode?: string
  }
  lead?: {
    name?: string
    email?: string
    cellphone?: string
    step?: number
  }
  contract?: {
    id?: string | number
    subscriber_code?: string
  }
}

function getMeta(metas: SaleMeta[] | undefined, key: string): string | null {
  return metas?.find((m) => m.meta_key === key)?.meta_value ?? null
}

const eventTypeLabels: Record<string, string> = {
  boleto: 'Boleto emitido',
  pix: 'PIX gerado',
  carrinho_abandonado: 'Carrinho abandonado',
  cartao_recusado: 'Cartao recusado',
  compra_aprovada: 'Compra aprovada',
}

const eventPriorityMap: Record<string, number> = {
  cartao_recusado: 3,
  boleto: 2,
  pix: 2,
  carrinho_abandonado: 1,
  compra_aprovada: 0,
}

function extractToken(req: NextRequest, body: GreennPayload): string | null {
  return (
    req.headers.get('x-greenn-token') ??
    req.headers.get('authorization')?.replace('Bearer ', '') ??
    body?.token ??
    new URL(req.url).searchParams.get('token') ??
    null
  )
}

function mapEventType(body: GreennPayload): string | null {
  const { event, type, currentStatus, product, sale } = body

  if (event === 'checkoutAbandoned' || type === 'lead') return 'carrinho_abandonado'

  if (event === 'saleUpdated' || event === 'contractUpdated') {
    if (currentStatus === 'paid' || currentStatus === 'trialing') return 'compra_aprovada'
    if (currentStatus === 'refused' || currentStatus === 'pending_payment' || currentStatus === 'unpaid') return 'cartao_recusado'
    if (currentStatus === 'waiting_payment') {
      // Método real da transação vem em sale.method; product.method é fallback.
      // PIX gerado e não pago é uma recuperação própria, separada do boleto.
      const method = (sale?.method ?? product?.method ?? '').toUpperCase()
      return method === 'PIX' ? 'pix' : 'boleto'
    }
  }

  return null
}

function mapPaymentType(method: string | undefined): string | null {
  if (!method) return null
  const m = method.toUpperCase()
  const map: Record<string, string> = {
    CREDIT_CARD: 'credit_card', DEBIT_CARD: 'debit_card',
    BOLETO: 'boleto', PIX: 'pix', PAYPAL: 'paypal',
  }
  return map[m] ?? m.toLowerCase()
}

function fmtCurrency(cents: number | null | undefined): string {
  if (!cents) return ''
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params

  // Barreira propria (nosso token) ANTES de qualquer processamento.
  const auth = checkWebhookToken(req)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status })
  }

  let body: GreennPayload
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Payload inválido' }, { status: 400 })
  }

  const [company] = await db.select().from(companies).where(eq(companies.slug, slug))
  if (!company) return NextResponse.json({ error: 'Empresa não encontrada' }, { status: 404 })

  const [config] = await db.select().from(settings).where(eq(settings.companyId, company.id))

  // Token Greenn do parceiro como camada ADICIONAL: so e exigido quando configurado.
  // Nosso token (checkWebhookToken) ja garante a barreira de autenticacao.
  if (config?.greennWebhookToken) {
    const incoming = extractToken(req, body)
    if (!incoming || incoming !== config.greennWebhookToken) {
      return NextResponse.json({ error: 'Token inválido' }, { status: 401 })
    }
  }

  const mappedType = mapEventType(body)
  if (!mappedType) return NextResponse.json({ ok: true, skipped: true })

  const productId = body.product?.id?.toString() ?? null
  const productName = body.product?.name ?? null

  const sequences = await db
    .select()
    .from(recoverySequences)
    .where(and(
      eq(recoverySequences.companyId, company.id),
      eq(recoverySequences.eventType, mappedType),
      eq(recoverySequences.isActive, true)
    ))

  // Prioriza sequência com productFilter que combina; fallback para sem filtro
  const sequence = sequences.find(s =>
    s.productFilter && (s.productFilter === productId || s.productFilter === productName)
  ) ?? sequences.find(s => !s.productFilter) ?? null

  const clientData = body.client ?? body.lead
  const phone = formatBrazilianPhone(clientData?.cellphone ?? '')
  const sale = body.sale
  const metas = body.saleMetas
  const transactionId = sale?.transaction ?? sale?.id?.toString() ?? body.contract?.id?.toString() ?? null

  const boletoCode = sale?.boleto_barcode ?? null
  const boletoUrl = sale?.boleto_url ?? null
  const boletoExpiry = sale?.boleto_expiration_date ? new Date(sale.boleto_expiration_date) : null
  // Greenn envia o PIX em sale.qrcode (copia-e-cola) e sale.imgQrcode (URL da imagem)
  const pixCode = sale?.qrcode ?? sale?.pix_code ?? sale?.pix_qr_code ?? null
  const pixExpiry = sale?.pix_expiration_date ? new Date(sale.pix_expiration_date) : null
  // Greenn envia amount em reais (ex: 37.00), convertemos para centavos
  const productValue = body.product?.amount != null ? Math.round(body.product.amount * 100) : null
  // Greenn: método real da transação está em sale.method, não em product.method
  const saleMethod = sale?.method ?? body.product?.method ?? ''


  const [lead] = await db
    .insert(recoveryLeads)
    .values({
      companyId: company.id,
      platform: 'greenn',
      eventType: mappedType,
      phone,
      name: clientData?.name ?? null,
      email: clientData?.email ?? null,
      cpfCnpj: body.client?.cpf_cnpj ?? null,
      city: body.client?.city ?? null,
      state: body.client?.state ?? null,
      country: body.client?.country ?? null,
      zipcode: body.client?.zipcode ?? null,
      productId,
      productName,
      productValue,
      priority: eventPriorityMap[mappedType] ?? 0,
      transactionId,
      paymentType: mapPaymentType(saleMethod),
      installments: sale?.installments ?? null,
      boletoCode,
      boletoUrl,
      boletoExpiry,
      pixCode,
      pixExpiry,
      affiliateCode: sale?.affiliate_code ?? null,
      commissionValue: sale?.commission != null ? Math.round(sale.commission * 100) : null,
      trackingSource: getMeta(metas, 'utm_source'),
      utmMedium: getMeta(metas, 'utm_medium'),
      utmCampaign: getMeta(metas, 'utm_campaign'),
      utmContent: getMeta(metas, 'utm_content'),
      utmTerm: getMeta(metas, 'utm_term'),
      utmPlacement: getMeta(metas, 'utm_placement'),
      metaCampaignId: getMeta(metas, 'campaign_id'),
      metaAdsetId: getMeta(metas, 'adset_id'),
      metaAdId: getMeta(metas, 'ad_id'),
      rawPayload: body,
      status: mappedType === 'compra_aprovada' ? 'completed' : 'pending',
    })
    .onConflictDoNothing({
      target: [recoveryLeads.companyId, recoveryLeads.platform, recoveryLeads.transactionId, recoveryLeads.eventType],
      where: sql`${recoveryLeads.transactionId} is not null`,
    })
    .returning()

  // Evento repetido: a Greenn reenvia o mesmo evento (retry) e o indice unico
  // parcial bloqueou a duplicata. Responde 200 sem reagendar nada.
  if (!lead) {
    return NextResponse.json({ ok: true, duplicate: true })
  }

  // Cancelar jobs pendentes e marcar como convertido quando chega compra_aprovada
  if (mappedType === 'compra_aprovada' && phone) {
    const leadsToCancel = await db
      .select({ id: recoveryLeads.id })
      .from(recoveryLeads)
      .where(and(
        eq(recoveryLeads.companyId, company.id),
        eq(recoveryLeads.phone, phone),
        inArray(recoveryLeads.eventType, ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado'])
      ))
    if (leadsToCancel.length > 0) {
      const leadIds = leadsToCancel.map(l => l.id)
      await db.update(messageJobs).set({ status: 'cancelled' })
        .where(and(inArray(messageJobs.leadId, leadIds), eq(messageJobs.status, 'pending')))

      // Atribuição correta: verifica se alguma mensagem já foi enviada para cada lead
      for (const leadId of leadIds) {
        const [lastSent] = await db
          .select({ messageOrder: messageJobs.messageOrder })
          .from(messageJobs)
          .where(and(eq(messageJobs.leadId, leadId), eq(messageJobs.status, 'sent')))
          .orderBy(desc(messageJobs.messageOrder))
          .limit(1)

        const convertedFrom = lastSent?.messageOrder != null
          ? `msg_${lastSent.messageOrder}`
          : 'webhook'

        await db.update(recoveryLeads)
          .set({ status: 'converted', convertedFrom, updatedAt: new Date() })
          .where(eq(recoveryLeads.id, leadId))
      }
    }
  }

  const RECOVERY_TYPES = ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado']
  const isRecovery = RECOVERY_TYPES.includes(mappedType)
  const MIN_FIRST_DELAY_MS = 30 * 60 * 1000
  const now = new Date()

  if (sequence) {
    const messages = await db
      .select()
      .from(sequenceMessages)
      .where(and(eq(sequenceMessages.sequenceId, sequence.id), eq(sequenceMessages.isActive, true)))
      .orderBy(sequenceMessages.order)

    if (messages.length > 0) {
      await db.insert(messageJobs).values(
        messages.map((msg, index) => {
          let delayMs = (msg.delayMinutes ?? 0) * 60 * 1000
          if (isRecovery && index === 0 && delayMs < MIN_FIRST_DELAY_MS) delayMs = MIN_FIRST_DELAY_MS
          return {
            leadId: lead.id,
            messageId: msg.id,
            scheduledFor: new Date(now.getTime() + delayMs),
            status: 'pending',
            checkBeforeSend: isRecovery,
            messageOrder: msg.order,
          }
        })
      )
    }

    if (!isRecovery && sequence.upsellMessage) {
      const upsellDelayMs = (sequence.upsellDelayMinutes ?? 1440) * 60 * 1000
      await db.insert(messageJobs).values({
        leadId: lead.id,
        upsellContent: sequence.upsellMessage,
        scheduledFor: new Date(now.getTime() + upsellDelayMs),
        status: 'pending',
        checkBeforeSend: false,
      })
    }
  }

  // Notificação interna (fire-and-forget)
  if (config?.notificationPhone) {
    const label = eventTypeLabels[mappedType] ?? mappedType
    const nome = clientData?.name ?? 'Desconhecido'
    const produto = body.product?.name ?? ''
    const valor = fmtCurrency(productValue)
    const msg = `*${label} (Greenn)*\nNome: ${nome}\nProduto: ${produto}\nValor: ${valor}\nTel: ${phone}`
    sendWhatsAppMessage(config.notificationPhone, { type: 'text', content: msg }, company.id).catch(() => {})
  }

  return NextResponse.json({ ok: true })
}
