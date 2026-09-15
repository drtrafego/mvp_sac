import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, settings, recoverySequences, sequenceMessages, recoveryLeads, messageJobs, webhookReceived } from '@/lib/db/schema'
import { eq, and, inArray, desc, sql } from 'drizzle-orm'
import { sendWhatsAppMessage, formatBrazilianPhone } from '@/lib/whatsapp'
import { checkWebhookToken } from '@/lib/webhook-auth'
import { maskedHeaders } from '@/lib/webhook-headers'

async function logReceived(args: {
  companyId: number | null
  slug: string
  event: string | null
  processed: boolean
  skipReason?: string | null
  errorMessage?: string | null
  leadId?: number | null
  rawBody: unknown
  headers: Record<string, string>
}) {
  try {
    await db.insert(webhookReceived).values({
      companyId: args.companyId,
      slug: args.slug,
      source: 'hotmart',
      event: args.event,
      processed: args.processed,
      skipReason: args.skipReason ?? null,
      errorMessage: args.errorMessage ?? null,
      leadId: args.leadId ?? null,
      rawBody: args.rawBody as object,
      headers: args.headers,
    })
  } catch (e) {
    console.error('[webhook_received insert failed]', e)
  }
}

function headersToObject(req: NextRequest): Record<string, string> {
  return maskedHeaders(req)
}

type HotmartPayload = {
  id?: string
  event?: string
  hottok?: string
  data?: {
    hottok?: string
    product?: {
      id?: number
      ucode?: string
      name?: string
      has_co_production?: boolean
    }
    buyer?: {
      name?: string
      first_name?: string
      last_name?: string
      email?: string
      document?: string
      document_type?: string
      phone?: string
      checkout_phone?: string
      checkout_phone_code?: string
      address?: {
        city?: string
        state?: string
        country?: string
        zipcode?: string
      }
    }
    producer?: {
      name?: string
      email?: string
      document?: string
    }
    affiliates?: Array<{
      affiliate_code?: string
      name?: string
      commission_amount?: number
    }>
    purchase?: {
      transaction?: string
      status?: string
      order_date?: number
      approved_date?: number
      full_price?: { value?: number; currency_value?: string }
      original_offer_price?: { value?: number; currency_value?: string }
      price?: { value?: number; currency_value?: string }
      commission?: { value?: number; currency_value?: string; base?: string }
      payment?: {
        type?: string
        installments_number?: number
        billet_url?: string
        billet_barcode?: string
        pix_code?: string
        pix_qr_code?: string
        pix_expiration_date?: number
      }
      tracking?: {
        source?: string
        source_sck?: string
        external_code?: string
      }
      order_bump?: { is_order_bump?: boolean }
      checkout_country?: { iso?: string; name?: string }
      offer?: { key?: string; payment_mode?: string }
      recurrence_number?: number | null
    }
    subscription?: {
      subscriber_code?: string
      status?: string
    }
  }
}

// ─── Eventos oficiais Hotmart Webhook v2.0.0 ─────────────────────────────────
// Fonte: https://developers.hotmart.com/docs/pt-BR/2.0.0/webhook/
// Lista puxada do /docs/page-data JSON em 2026-06-02. Total: 15 eventos.
// Esta constante é a fonte da verdade; mantemos aliases antigos por compatibilidade.
type EventType =
  | 'boleto'
  | 'pix'
  | 'carrinho_abandonado'
  | 'cartao_recusado'
  | 'compra_aprovada'
  | 'disputa'

const HOTMART_EVENTS = {
  // Compras (10)
  PURCHASE_APPROVED: 'PURCHASE_APPROVED',
  PURCHASE_BILLET_PRINTED: 'PURCHASE_BILLET_PRINTED',
  PURCHASE_CANCELED: 'PURCHASE_CANCELED',
  PURCHASE_CHARGEBACK: 'PURCHASE_CHARGEBACK',
  PURCHASE_COMPLETE: 'PURCHASE_COMPLETE',
  PURCHASE_DELAYED: 'PURCHASE_DELAYED',
  PURCHASE_EXPIRED: 'PURCHASE_EXPIRED',
  PURCHASE_PROTEST: 'PURCHASE_PROTEST',
  PURCHASE_REFUNDED: 'PURCHASE_REFUNDED',
  PURCHASE_OUT_OF_SHOPPING_CART: 'PURCHASE_OUT_OF_SHOPPING_CART',
  // Assinatura (3)
  SUBSCRIPTION_CANCELLATION: 'SUBSCRIPTION_CANCELLATION',
  UPDATE_SUBSCRIPTION_CHARGE_DATE: 'UPDATE_SUBSCRIPTION_CHARGE_DATE',
  SWITCH_PLAN: 'SWITCH_PLAN',
  // Club / área de membros (2)
  CLUB_FIRST_ACCESS: 'CLUB_FIRST_ACCESS',
  CLUB_MODULE_COMPLETED: 'CLUB_MODULE_COMPLETED',
} as const

// Aliases legados (Hotmart v1 / nomes antigos usados em integrações pré-2.0.0)
const LEGACY_ALIASES: Record<string, string> = {
  ABANDONED_CART: 'PURCHASE_OUT_OF_SHOPPING_CART',
  BILLET_PRINTED: 'PURCHASE_BILLET_PRINTED',
  WAITING_PAYMENT: 'PURCHASE_BILLET_PRINTED',
  PURCHASE_WAITING_PAYMENT: 'PURCHASE_BILLET_PRINTED',
}

// Status possíveis dentro de data.purchase.status (17 valores oficiais)
type PurchaseStatus =
  | 'APPROVED' | 'BLOCKED' | 'CANCELED' | 'CANCELLED' | 'CHARGEBACK'
  | 'COMPLETE' | 'EXPIRED' | 'NO_FUNDS' | 'OVERDUE' | 'PARTIALLY_REFUNDED'
  | 'PRE_ORDER' | 'PRINTED_BILLET' | 'PROCESSING_TRANSACTION' | 'REFUNDED'
  | 'STARTED' | 'UNDER_ANALISYS' | 'WAITING_PAYMENT'

type MapResult = { type: EventType | null; reason?: string }

function mapHotmartEvent(event: string | undefined | null, status?: string, paymentMethod?: string): MapResult {
  if (!event) return { type: null, reason: 'no_event_field' }

  let evt = event.toUpperCase()
  if (LEGACY_ALIASES[evt]) {
    console.warn(`[hotmart webhook] evento legado "${evt}" → "${LEGACY_ALIASES[evt]}"`)
    evt = LEGACY_ALIASES[evt]
  }

  const s: string = (status ?? '').toUpperCase()
  const method: string = (paymentMethod ?? '').toUpperCase()

  const res: MapResult = (() => {
    switch (evt) {
      case 'PURCHASE_APPROVED':
        if (s === 'APPROVED' || s === 'COMPLETE' || s === '') return { type: 'compra_aprovada' }
        if (s === 'NO_FUNDS' || s === 'BLOCKED' || s === 'UNDER_ANALISYS') return { type: 'cartao_recusado' }
        return { type: 'compra_aprovada' }

      case 'PURCHASE_COMPLETE':
        // Caso especial legado: alguns payloads antigos mandavam REFUSED/RECUSADO aqui
        if (s === 'REFUSED' || s === 'RECUSADO' || s === 'NO_FUNDS' || s === 'BLOCKED') {
          return { type: 'cartao_recusado' }
        }
        return { type: 'compra_aprovada' }

      case 'PURCHASE_BILLET_PRINTED':
        return { type: 'boleto' }

      case 'PURCHASE_DELAYED':
        // Recorrência atrasada: se ainda dá para pagar (aguardando), tratamos como boleto/lembrete
        if (s === 'WAITING_PAYMENT' || s === 'OVERDUE' || s === 'PRINTED_BILLET') return { type: 'boleto' }
        return { type: 'disputa' }

      case 'PURCHASE_OUT_OF_SHOPPING_CART':
        return { type: 'carrinho_abandonado' }

      case 'PURCHASE_CANCELED':
      case 'PURCHASE_EXPIRED':
        // Venda não se concretizou: oportunidade de recuperação como "cartão recusado"
        return { type: 'cartao_recusado' }

      case 'PURCHASE_REFUNDED':
      case 'PURCHASE_CHARGEBACK':
      case 'PURCHASE_PROTEST':
        return { type: 'disputa' }

      case 'SUBSCRIPTION_CANCELLATION':
      case 'UPDATE_SUBSCRIPTION_CHARGE_DATE':
      case 'SWITCH_PLAN':
      case 'CLUB_FIRST_ACCESS':
      case 'CLUB_MODULE_COMPLETED':
        return { type: null, reason: `evento_informativo:${evt}` }

      default:
        return { type: null, reason: `evento_desconhecido:${evt}` }
    }
  })()

  // PIX gerado e não pago é uma recuperação própria, separada do boleto.
  // A Hotmart envia o aguardando-pagamento de PIX com o mesmo evento do boleto;
  // distinguimos pelo método de pagamento (payment.type = PIX).
  if (res.type === 'boleto' && method === 'PIX') return { type: 'pix' }
  return res
}

// Fase 3.2: prioridade por tipo de evento (maior = atende primeiro)
const eventPriorityMap: Record<string, number> = {
  cartao_recusado: 3,
  boleto: 2,
  pix: 2,
  carrinho_abandonado: 1,
  compra_aprovada: 0,
  disputa: 0,
}

const eventTypeLabels: Record<string, string> = {
  boleto: 'Boleto emitido',
  pix: 'PIX gerado',
  carrinho_abandonado: 'Carrinho abandonado',
  cartao_recusado: 'Cartao recusado',
  compra_aprovada: 'Compra aprovada',
  disputa: 'Disputa / chargeback',
}

function extractToken(req: NextRequest, body: HotmartPayload): string | null {
  const headerToken = req.headers.get('x-hotmart-webhook-token')
  if (headerToken) return headerToken
  const authHeader = req.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)
  if (body?.hottok) return body.hottok
  if (body?.data?.hottok) return body.data.hottok
  return new URL(req.url).searchParams.get('hottok')
}

function formatPhone(code: string | undefined, phone: string): string {
  const codeClean = (code ?? '').replace(/\D/g, '')
  // Número de outro país: só concatena DDI + número limpo
  if (codeClean && codeClean !== '55') return `${codeClean}${phone.replace(/\D/g, '')}`
  return formatBrazilianPhone(phone)
}

function toCents(value: number | undefined | null): number | null {
  if (value == null) return null
  return Math.round(value * 100)
}

function fmtCurrency(cents: number | null): string {
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

  const headersObj = headersToObject(req)

  // Lê corpo cru primeiro para garantir log mesmo se o JSON falhar
  const rawText = await req.text()
  let body: HotmartPayload
  try {
    body = JSON.parse(rawText) as HotmartPayload
  } catch {
    await logReceived({
      companyId: null, slug, event: null, processed: false,
      skipReason: 'invalid_json', rawBody: { _raw: rawText.slice(0, 4000) }, headers: headersObj,
    })
    return NextResponse.json({ error: 'Payload inválido' }, { status: 400 })
  }

  const [company] = await db.select().from(companies).where(eq(companies.slug, slug))
  if (!company) {
    await logReceived({
      companyId: null, slug, event: body?.event ?? null, processed: false,
      skipReason: 'company_not_found', rawBody: body, headers: headersObj,
    })
    return NextResponse.json({ error: 'Empresa não encontrada' }, { status: 404 })
  }

  const [config] = await db.select().from(settings).where(eq(settings.companyId, company.id))

  // Hottok do parceiro como camada ADICIONAL: so e exigido quando configurado.
  // Nosso token (checkWebhookToken) ja garante a barreira de autenticacao.
  if (config?.hotmartWebhookToken) {
    const incoming = extractToken(req, body)
    if (!incoming || incoming !== config.hotmartWebhookToken) {
      await logReceived({
        companyId: company.id, slug, event: body?.event ?? null, processed: false,
        skipReason: 'invalid_token', rawBody: body, headers: headersObj,
      })
      return NextResponse.json({ error: 'Token inválido' }, { status: 401 })
    }
  }

  const event = body.event
  const data = body.data
  const purchase = data?.purchase
  const buyer = data?.buyer
  const payment = purchase?.payment

  const { type: mappedType, reason: mapReason } = mapHotmartEvent(event, purchase?.status, payment?.type)

  if (!mappedType) {
    await logReceived({
      companyId: company.id, slug, event: event ?? null, processed: false,
      skipReason: mapReason ?? 'no_event_field',
      rawBody: body, headers: headersObj,
    })
    // Hotmart desativa webhooks que retornam erro com frequência: sempre 200 quando ignoramos
    return NextResponse.json({ ok: true, skipped: true, reason: mapReason })
  }

  const productId = data?.product?.ucode ?? data?.product?.id?.toString() ?? null
  const productName = data?.product?.name ?? null

  // Busca sequências ativas para este tipo de evento
  const sequences = await db
    .select()
    .from(recoverySequences)
    .where(and(
      eq(recoverySequences.companyId, company.id),
      eq(recoverySequences.eventType, mappedType),
      eq(recoverySequences.isActive, true)
    ))

  // Fase 3.1: prioriza sequência com productFilter que combina; fallback para sem filtro
  const sequence = sequences.find(s =>
    s.productFilter && (s.productFilter === productId || s.productFilter === productName)
  ) ?? sequences.find(s => !s.productFilter) ?? null

  const phone = formatPhone(buyer?.checkout_phone_code, buyer?.checkout_phone ?? buyer?.phone ?? '')

  const rawPaymentType = payment?.type?.toUpperCase() ?? ''
  const paymentTypeMap: Record<string, string> = {
    BILLET: 'boleto', BOLETO: 'boleto', PIX: 'pix',
    CREDIT_CARD: 'credit_card', DEBIT_CARD: 'debit_card', PAYPAL: 'paypal',
  }
  const paymentType = paymentTypeMap[rawPaymentType] ?? (rawPaymentType.toLowerCase() || null)

  const boletoCode = payment?.billet_barcode ?? null
  const boletoUrl = payment?.billet_url ?? null
  const pixCode = payment?.pix_code ?? payment?.pix_qr_code ?? null
  const pixExpiry = payment?.pix_expiration_date ? new Date(payment.pix_expiration_date) : null
  const orderDate = purchase?.order_date ? new Date(purchase.order_date) : null
  const approvedDate = purchase?.approved_date ? new Date(purchase.approved_date) : null
  const affiliate = data?.affiliates?.[0]
  const productValue = toCents(purchase?.price?.value ?? purchase?.full_price?.value)

  let lead: typeof recoveryLeads.$inferSelect | undefined
  try {
    [lead] = await db
    .insert(recoveryLeads)
    .values({
      companyId: company.id,
      platform: 'hotmart',
      eventType: mappedType,
      phone,
      name: buyer?.name ?? null,
      email: buyer?.email ?? null,
      cpfCnpj: buyer?.document ?? null,
      city: buyer?.address?.city ?? null,
      state: buyer?.address?.state ?? null,
      country: buyer?.address?.country ?? null,
      zipcode: buyer?.address?.zipcode ?? null,
      productId,
      productName,
      productValue,
      priority: eventPriorityMap[mappedType] ?? 0,
      transactionId: purchase?.transaction ?? null,
      paymentType,
      installments: payment?.installments_number ?? null,
      boletoCode,
      boletoUrl,
      boletoExpiry: null,
      pixCode,
      pixExpiry,
      trackingSource: purchase?.tracking?.source ?? null,
      trackingSourceSck: purchase?.tracking?.source_sck ?? null,
      trackingExternalCode: purchase?.tracking?.external_code ?? null,
      affiliateCode: affiliate?.affiliate_code ?? null,
      commissionValue: toCents(affiliate?.commission_amount ?? purchase?.commission?.value),
      orderDate,
      approvedDate,
      isOrderBump: purchase?.order_bump?.is_order_bump ?? false,
      rawPayload: body,
      status: mappedType === 'compra_aprovada' ? 'completed' : 'pending',
    })
    .onConflictDoNothing({
      target: [recoveryLeads.companyId, recoveryLeads.platform, recoveryLeads.transactionId, recoveryLeads.eventType],
      where: sql`${recoveryLeads.transactionId} is not null`,
    })
    .returning()
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    await logReceived({
      companyId: company.id, slug, event: event ?? null, processed: false,
      skipReason: 'lead_insert_failed', errorMessage: errMsg,
      rawBody: body, headers: headersObj,
    })
    return NextResponse.json({ error: 'Falha ao gravar lead' }, { status: 500 })
  }

  // Evento repetido: a Hotmart reenvia o mesmo evento (retry) e o indice unico
  // parcial bloqueou a duplicata. Responde 200 sem reagendar nada.
  if (!lead) {
    await logReceived({
      companyId: company.id, slug, event: event ?? null, processed: false,
      skipReason: 'duplicate_transaction', rawBody: body, headers: headersObj,
    })
    return NextResponse.json({ ok: true, duplicate: true })
  }

  // Cancelar jobs pendentes de recuperação quando chega compra_aprovada
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

  // Disputa: apenas registra o lead, não envia nada
  if (sequence && mappedType !== 'disputa') {
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
    const nome = buyer?.name ?? 'Desconhecido'
    const produto = data?.product?.name ?? ''
    const valor = fmtCurrency(productValue)
    const msg = `*${label} (Hotmart)*\nNome: ${nome}\nProduto: ${produto}\nValor: ${valor}\nTel: ${phone}`
    sendWhatsAppMessage(config.notificationPhone, { type: 'text', content: msg }, company.id).catch(() => {})
  }

  await logReceived({
    companyId: company.id, slug, event: event ?? null, processed: true,
    leadId: lead.id, rawBody: body, headers: headersObj,
  })

  return NextResponse.json({ ok: true })
}
