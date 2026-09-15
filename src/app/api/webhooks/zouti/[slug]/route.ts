import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { db } from '@/lib/db'
import { companies, settings, recoverySequences, sequenceMessages, recoveryLeads, messageJobs, webhookReceived } from '@/lib/db/schema'
import { eq, and, inArray, desc, sql } from 'drizzle-orm'
import { sendWhatsAppMessage, formatBrazilianPhone } from '@/lib/whatsapp'
import { checkWebhookToken } from '@/lib/webhook-auth'
import { maskedHeaders } from '@/lib/webhook-headers'

// ─── Tipos do payload Zouti ──────────────────────────────────────────────────
// Fonte: https://ajuda.zouti.com.br/pt-br/articles/9740950-como-configurar-webhook
// A Zouti envia 3 formatos: pedido (order, id "ord_"), carrinho abandonado
// (id "ab_..."/campo "step") e assinatura (subscription). Os campos exatos de
// boleto/PIX (codigo de barras, copia-e-cola, expiracao) nao estao na doc publica;
// lemos de varios caminhos provaveis e sempre gravamos rawPayload para calibrar.

type ZoutiItem = {
  product_id?: string
  variant_id?: string
  name?: string
  description?: string
  amount?: number          // em centavos
  amount_in_brl?: number
  quantity?: number
  image_url?: string
  type?: string
}

type ZoutiCustomer = {
  id?: string
  name?: string
  email?: string
  document?: string
  phone?: string
  cellphone?: string
  instagram?: string
  city?: string
  state?: string
  country?: string
  zipcode?: string
}

type ZoutiPayment = {
  method?: string          // CREDIT_CARD | BOLETO | PIX
  installments?: number
  // Campos provaveis de boleto/PIX (nomes nao confirmados na doc publica)
  boleto_url?: string
  boleto_barcode?: string
  barcode?: string
  url?: string
  pix_code?: string
  pix_qr_code?: string
  qr_code?: string
  qrcode?: string
  expiration_date?: string
  expires_at?: string
}

type ZoutiUtm = {
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_content?: string
  utm_term?: string
  src?: string
  sck?: string
  campaign_id?: string
  adset_id?: string
  ad_id?: string
}

type ZoutiPayload = {
  // identificacao / roteamento
  id?: string
  account_id?: string
  event?: string
  type?: string
  token?: string
  // pedido
  status?: string          // PAID | AWAITING_PAYMENT | UNPAID | REFUNDED | DISPUTED | TRIAL | CANCELED
  payment_type?: string    // UNIQUE | ... (tipo de cobranca, nao o metodo)
  order_session_id?: string
  order_id?: string        // evento de pagamento (pmt_) aponta para o pedido (ord_)
  amount_subtotal?: number
  amount_subtotal_in_brl?: number
  amount_total?: number
  amount_total_in_brl?: number
  currency?: string
  // carrinho abandonado
  step?: string
  total_amount?: number
  total_amount_in_brl?: number
  url?: string
  ip_address?: string
  // comuns
  items?: ZoutiItem[]
  line_items?: ZoutiItem[]
  customer?: ZoutiCustomer
  lead?: ZoutiCustomer
  payment?: ZoutiPayment
  payment_method?: string
  utm_data?: ZoutiUtm
  tracking?: ZoutiUtm
  metadata?: Record<string, unknown> & { payment_method?: string }
  commission?: number
  affiliate_code?: string
  created_at?: string
  updated_at?: string
}

// ─── Log de auditoria (igual ao webhook Hotmart) ─────────────────────────────
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
      source: 'zouti',
      event: args.event,
      processed: args.processed,
      skipReason: args.skipReason ?? null,
      errorMessage: args.errorMessage ?? null,
      leadId: args.leadId ?? null,
      rawBody: args.rawBody as object,
      headers: args.headers,
    })
  } catch (e) {
    console.error('[webhook_received zouti insert failed]', e)
  }
}

function headersToObject(req: NextRequest): Record<string, string> {
  return maskedHeaders(req)
}

const eventTypeLabels: Record<string, string> = {
  boleto: 'Boleto emitido',
  pix: 'PIX gerado',
  carrinho_abandonado: 'Carrinho abandonado',
  cartao_recusado: 'Cartao recusado',
  compra_aprovada: 'Compra aprovada',
  disputa: 'Disputa / chargeback',
}

const eventPriorityMap: Record<string, number> = {
  cartao_recusado: 3,
  boleto: 2,
  pix: 2,
  carrinho_abandonado: 1,
  compra_aprovada: 0,
  disputa: 0,
}

// ─── Validação de assinatura Zouti ───────────────────────────────────────────
// A Zouti envia o header x-zouti-signature no formato "t=<timestamp>,v1=<hmac>",
// onde v1 = HMAC-SHA256(secret, raw body) em hex. Validamos em tempo constante e
// rejeitamos timestamps fora da janela de 5 min (anti-replay). Por robustez,
// aceitamos também a variante que assina "<t>.<raw body>" (esquema comum estilo
// Stripe), caso a Zouti use essa forma.
const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000

function safeEqualHex(aHex: string, bHex: string): boolean {
  try {
    const a = Buffer.from(aHex, 'hex')
    const b = Buffer.from(bHex, 'hex')
    if (a.length === 0 || a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function verifyZoutiSignature(rawBody: string, header: string | null, secret: string): { ok: boolean; reason?: string } {
  if (!header) return { ok: false, reason: 'missing_signature_header' }

  const parts: Record<string, string> = {}
  for (const kv of header.split(',')) {
    const i = kv.indexOf('=')
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim()
  }
  const t = parts['t']
  const v1 = parts['v1']
  if (!t || !v1) return { ok: false, reason: 'malformed_signature_header' }

  let ts = Number(t)
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid_timestamp' }
  if (ts < 1e12) ts = ts * 1000 // Zouti manda em ms; aceita segundos por garantia
  if (Math.abs(Date.now() - ts) > SIGNATURE_TOLERANCE_MS) return { ok: false, reason: 'timestamp_expired' }

  const candidates = [
    crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex'),
    crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex'),
  ]
  for (const c of candidates) {
    if (safeEqualHex(c, v1)) return { ok: true }
  }
  return { ok: false, reason: 'signature_mismatch' }
}

type MapResult = { type: string | null; reason?: string }

// Mapeia o payload Zouti para nossos tipos internos de evento.
function mapEventType(body: ZoutiPayload): MapResult {
  // Carrinho abandonado: id "ab_", campo "step", ou evento explicito.
  const isAbandoned =
    body.type === 'lead' ||
    body.event === 'checkoutAbandoned' ||
    body.event === 'abandoned_cart' ||
    (typeof body.id === 'string' && body.id.startsWith('ab_')) ||
    (body.step != null && body.status == null)
  if (isAbandoned) return { type: 'carrinho_abandonado' }

  const status = (body.status ?? '').toUpperCase()
  const method = (body.payment?.method ?? body.payment_method ?? body.metadata?.payment_method ?? '').toUpperCase()

  if (!status) return { type: null, reason: 'no_status_field' }

  switch (status) {
    case 'PAID':
    case 'TRIAL':
      return { type: 'compra_aprovada' }

    case 'AWAITING_PAYMENT':
    case 'UNPAID': {
      if (method === 'PIX') return { type: 'pix' }
      if (method === 'BOLETO') return { type: 'boleto' }
      // Cartao aguardando/nao pago = tentativa recusada
      if (method === 'CREDIT_CARD' || method === 'DEBIT_CARD') return { type: 'cartao_recusado' }
      // Sem metodo claro: trata como boleto (recuperacao com lembrete de pagamento)
      return { type: 'boleto' }
    }

    case 'CANCELED':
    case 'CANCELLED':
      if (method === 'CREDIT_CARD' || method === 'DEBIT_CARD') return { type: 'cartao_recusado' }
      return { type: 'disputa' }

    case 'REFUNDED':
    case 'DISPUTED':
    case 'CHARGEBACK':
      return { type: 'disputa' }

    default:
      return { type: null, reason: `status_desconhecido:${status}` }
  }
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

// A Zouti envia valores em centavos (amount_total) e tambem em reais (amount_total_in_brl).
// Preferimos os centavos; se so vier reais, convertemos.
function pickCents(cents: number | undefined, reais: number | undefined): number | null {
  if (cents != null) return Math.round(cents)
  if (reais != null) return Math.round(reais * 100)
  return null
}

function parseDate(v: string | undefined | null): Date | null {
  if (!v) return null
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d
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

  const rawText = await req.text()
  let body: ZoutiPayload
  try {
    body = JSON.parse(rawText) as ZoutiPayload
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
      companyId: null, slug, event: body?.event ?? body?.status ?? null, processed: false,
      skipReason: 'company_not_found', rawBody: body, headers: headersObj,
    })
    return NextResponse.json({ error: 'Empresa não encontrada' }, { status: 404 })
  }

  const [config] = await db.select().from(settings).where(eq(settings.companyId, company.id))

  // Assinatura HMAC Zouti como camada ADICIONAL: so e exigida quando o secret do
  // parceiro estiver configurado. Nosso token (checkWebhookToken) ja garante a
  // barreira de autenticacao.
  if (config?.zoutiWebhookToken) {
    const sig = verifyZoutiSignature(rawText, req.headers.get('x-zouti-signature'), config.zoutiWebhookToken)
    if (!sig.ok) {
      await logReceived({
        companyId: company.id, slug, event: body?.event ?? body?.status ?? null, processed: false,
        skipReason: `invalid_signature:${sig.reason}`, rawBody: body, headers: headersObj,
      })
      return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 })
    }
  }

  const eventLabel = body.event ?? body.status ?? null
  const { type: mappedType, reason: mapReason } = mapEventType(body)

  if (!mappedType) {
    await logReceived({
      companyId: company.id, slug, event: eventLabel, processed: false,
      skipReason: mapReason ?? 'unmapped', rawBody: body, headers: headersObj,
    })
    // Sempre 200 quando ignoramos, para a Zouti nao desativar o webhook
    return NextResponse.json({ ok: true, skipped: true, reason: mapReason })
  }

  const items = body.items ?? body.line_items ?? []
  const firstItem = items[0]
  const productId = firstItem?.product_id ?? null
  const productName = firstItem?.name ?? null

  const sequences = await db
    .select()
    .from(recoverySequences)
    .where(and(
      eq(recoverySequences.companyId, company.id),
      eq(recoverySequences.eventType, mappedType),
      eq(recoverySequences.isActive, true)
    ))

  const sequence = sequences.find(s =>
    s.productFilter && (s.productFilter === productId || s.productFilter === productName)
  ) ?? sequences.find(s => !s.productFilter) ?? null

  const customer = body.customer ?? body.lead
  const phone = formatBrazilianPhone(customer?.phone ?? customer?.cellphone ?? '')

  const method = body.payment?.method ?? body.payment_method ?? body.metadata?.payment_method
  const payment = body.payment ?? {}

  const boletoCode = payment.boleto_barcode ?? payment.barcode ?? null
  const boletoUrl = payment.boleto_url ?? (mappedType === 'boleto' ? payment.url ?? null : null)
  const boletoExpiry = mappedType === 'boleto' ? parseDate(payment.expiration_date ?? payment.expires_at) : null
  const pixCode = payment.pix_code ?? payment.qrcode ?? payment.qr_code ?? payment.pix_qr_code ?? null
  const pixExpiry = mappedType === 'pix' ? parseDate(payment.expiration_date ?? payment.expires_at) : null

  const productValue = pickCents(body.amount_total ?? body.total_amount, body.amount_total_in_brl ?? body.total_amount_in_brl)

  const utm = body.utm_data ?? body.tracking ?? {}
  // A Zouti dispara DOIS webhooks PAID para a mesma venda: o evento do pedido
  // (id "ord_xxx", sem order_id) e o do pagamento (id "pmt_xxx", com
  // order_id="ord_xxx"). Resolvemos ambos para o mesmo transaction_id usando
  // order_id quando presente, para colidirem no indice unico e fazerem merge.
  const transactionId = body.order_id ?? body.id ?? body.order_session_id ?? null

  let lead: { id: number; wasInserted: boolean } | undefined
  try {
    [lead] = await db
      .insert(recoveryLeads)
      .values({
        companyId: company.id,
        platform: 'zouti',
        eventType: mappedType,
        phone,
        name: customer?.name ?? null,
        email: customer?.email ?? null,
        cpfCnpj: customer?.document ?? null,
        city: customer?.city ?? null,
        state: customer?.state ?? null,
        country: customer?.country ?? null,
        zipcode: customer?.zipcode ?? null,
        productId,
        productName,
        productValue,
        priority: eventPriorityMap[mappedType] ?? 0,
        transactionId,
        paymentType: mapPaymentType(method),
        installments: payment.installments ?? null,
        boletoCode,
        boletoUrl,
        boletoExpiry,
        pixCode,
        pixExpiry,
        affiliateCode: body.affiliate_code ?? null,
        commissionValue: body.commission != null ? Math.round(body.commission) : null,
        trackingSource: utm.utm_source ?? utm.src ?? null,
        trackingSourceSck: utm.sck ?? null,
        utmMedium: utm.utm_medium ?? null,
        utmCampaign: utm.utm_campaign ?? null,
        utmContent: utm.utm_content ?? null,
        utmTerm: utm.utm_term ?? null,
        metaCampaignId: utm.campaign_id ?? null,
        metaAdsetId: utm.adset_id ?? null,
        metaAdId: utm.ad_id ?? null,
        orderDate: parseDate(body.created_at),
        approvedDate: mappedType === 'compra_aprovada' ? parseDate(body.updated_at ?? body.created_at) : null,
        rawPayload: body,
        status: mappedType === 'compra_aprovada' ? 'completed' : 'pending',
      })
      // Merge ao inves de DoNothing: os dois eventos PAID (ord_ e pmt_) chegam em
      // ordem imprevisivel. O pmt_ vem quase vazio; se gravasse primeiro com
      // DoNothing, o ord_ (com valor real) seria ignorado. coalesce(excluded, atual)
      // garante que o valor nao-nulo prevaleca, venha de qual evento vier.
      .onConflictDoUpdate({
        target: [recoveryLeads.companyId, recoveryLeads.platform, recoveryLeads.transactionId, recoveryLeads.eventType],
        targetWhere: sql`${recoveryLeads.transactionId} is not null`,
        set: {
          productValue: sql`coalesce(excluded.product_value, ${recoveryLeads.productValue})`,
          productId: sql`coalesce(excluded.product_id, ${recoveryLeads.productId})`,
          productName: sql`coalesce(excluded.product_name, ${recoveryLeads.productName})`,
          paymentType: sql`coalesce(excluded.payment_type, ${recoveryLeads.paymentType})`,
          installments: sql`coalesce(excluded.installments, ${recoveryLeads.installments})`,
          boletoCode: sql`coalesce(excluded.boleto_code, ${recoveryLeads.boletoCode})`,
          boletoUrl: sql`coalesce(excluded.boleto_url, ${recoveryLeads.boletoUrl})`,
          pixCode: sql`coalesce(excluded.pix_code, ${recoveryLeads.pixCode})`,
          name: sql`coalesce(excluded.name, ${recoveryLeads.name})`,
          email: sql`coalesce(excluded.email, ${recoveryLeads.email})`,
          cpfCnpj: sql`coalesce(excluded.cpf_cnpj, ${recoveryLeads.cpfCnpj})`,
          trackingSource: sql`coalesce(excluded.tracking_source, ${recoveryLeads.trackingSource})`,
          utmMedium: sql`coalesce(excluded.utm_medium, ${recoveryLeads.utmMedium})`,
          utmCampaign: sql`coalesce(excluded.utm_campaign, ${recoveryLeads.utmCampaign})`,
          utmContent: sql`coalesce(excluded.utm_content, ${recoveryLeads.utmContent})`,
          utmTerm: sql`coalesce(excluded.utm_term, ${recoveryLeads.utmTerm})`,
          orderDate: sql`coalesce(excluded.order_date, ${recoveryLeads.orderDate})`,
          approvedDate: sql`coalesce(excluded.approved_date, ${recoveryLeads.approvedDate})`,
          updatedAt: sql`now()`,
        },
      })
      // (xmax = 0) distingue INSERT novo de UPDATE: xmax fica zerado apenas em
      // linhas recem-inseridas. Usado para nao reprocessar agendamento/notificacao
      // quando chega o segundo evento (duplicata atualizada via merge).
      .returning({
        id: recoveryLeads.id,
        wasInserted: sql<boolean>`(xmax = 0)`,
      })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    await logReceived({
      companyId: company.id, slug, event: eventLabel, processed: false,
      skipReason: 'lead_insert_failed', errorMessage: errMsg,
      rawBody: body, headers: headersObj,
    })
    return NextResponse.json({ error: 'Falha ao gravar lead' }, { status: 500 })
  }

  // Salvaguarda: com onConflictDoUpdate o returning sempre traz a linha. Se vier
  // vazio e algo inesperado, evita seguir com lead indefinido.
  if (!lead) {
    await logReceived({
      companyId: company.id, slug, event: eventLabel, processed: false,
      skipReason: 'lead_insert_no_return', rawBody: body, headers: headersObj,
    })
    return NextResponse.json({ ok: true, duplicate: true })
  }

  // Segundo evento da mesma venda (duplicata): o merge ja atualizou os campos
  // nao-nulos. Nao reprocessa agendamento de mensagens nem notificacao interna,
  // senao o dono receberia notificacao duplicada e os jobs seriam recriados.
  if (!lead.wasInserted) {
    await logReceived({
      companyId: company.id, slug, event: eventLabel, processed: false,
      skipReason: 'duplicate_transaction_merged', rawBody: body, headers: headersObj, leadId: lead.id,
    })
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

  // Disputa: apenas registra o lead, nao envia nada
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

  // Notificacao interna (fire-and-forget)
  if (config?.notificationPhone) {
    const label = eventTypeLabels[mappedType] ?? mappedType
    const nome = customer?.name ?? 'Desconhecido'
    const produto = productName ?? ''
    const valor = fmtCurrency(productValue)
    const msg = `*${label} (Zouti)*\nNome: ${nome}\nProduto: ${produto}\nValor: ${valor}\nTel: ${phone}`
    sendWhatsAppMessage(config.notificationPhone, { type: 'text', content: msg }, company.id).catch(() => {})
  }

  await logReceived({
    companyId: company.id, slug, event: eventLabel, processed: true,
    leadId: lead.id, rawBody: body, headers: headersObj,
  })

  return NextResponse.json({ ok: true })
}
