import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { companies, settings, recoverySequences, sequenceMessages, recoveryLeads, messageJobs, webhookReceived } from '@/lib/db/schema'
import { db } from '@/lib/db'
import { eq, and, inArray, desc, sql } from 'drizzle-orm'
import { sendWhatsAppMessage, formatBrazilianPhone } from '@/lib/whatsapp'
import { checkWebhookToken } from '@/lib/webhook-auth'
import { maskedHeaders } from '@/lib/webhook-headers'

// ─── Tipos do payload Kiwify ─────────────────────────────────────────────────
// Fonte: docs.kiwify.com.br, exemplos oficiais de payload e captura real do
// fluxo n8n da cliente (fevereiro de 2025).
//
// A Kiwify manda DOIS formatos completamente diferentes no mesmo endpoint:
//   1. PEDIDO: flat no topo, com objetos PascalCase aninhados (Product, Customer,
//      Commissions, TrackingParameters, Subscription) e campo webhook_event_type.
//   2. CARRINHO ABANDONADO: flat, sem objetos aninhados, SEM webhook_event_type,
//      identificado por status = 'abandoned'. Pode chegar como ARRAY de itens.
//
// Armadilhas de nomenclatura:
//   . boleto_URL vem com U MAIÚSCULO no webhook; a API REST usa boleto_url
//     minúsculo. Lemos os dois.
//   . o documento vem em Customer.CPF (maiúsculo) ou Customer.cnpj (minúsculo).
//   . os valores JÁ vêm em CENTAVOS, ao contrário de Hotmart e Greenn.
//   . são quatro formatos de data diferentes, ver parseKiwifyDate.

type KiwifyCommissionedStore = {
  id?: string
  type?: string                 // producer | coproducer | affiliate
  affiliate_id?: string
  custom_name?: string
  email?: string
  value?: number | string
}

type KiwifyPayload = {
  // ── formato PEDIDO ──
  order_id?: string
  order_ref?: string
  order_status?: string          // paid | waiting_payment | refused | refunded | chargedback
  product_type?: string
  payment_method?: string        // credit_card | boleto | pix
  payment_merchant_id?: number | string
  installments?: number | string
  card_type?: string
  card_last4digits?: string
  card_rejection_reason?: string
  sale_type?: string
  boleto_URL?: string            // U maiúsculo, formato do webhook
  boleto_url?: string            // minúsculo, formato da API REST
  boleto_barcode?: string
  boleto_expiry_date?: string    // dd/MM/yyyy
  pix_code?: string
  pix_expiration?: string        // dd/MM/yyyy HH:mm
  created_at?: string            // pedido: "yyyy-MM-dd HH:mm" | abandono: ISO com offset
  updated_at?: string
  approved_date?: string
  refunded_at?: string | null
  webhook_event_type?: string
  access_url?: string | null
  subscription_id?: string

  Product?: {
    product_id?: string
    product_name?: string
  }
  Customer?: {
    full_name?: string
    first_name?: string
    email?: string
    mobile?: string
    CPF?: string                 // maiúsculo, pessoa física
    cnpj?: string                // minúsculo, pessoa jurídica
    ip?: string
    instagram?: string
    street?: string
    number?: string
    complement?: string
    neighborhood?: string
    city?: string
    state?: string
    country?: string             // não confirmado no payload de pedido
    zipcode?: string
  }
  Commissions?: {
    charge_amount?: number | string        // CENTAVOS, bruto cobrado do cliente
    product_base_price?: number | string   // CENTAVOS
    kiwify_fee?: number | string
    settlement_amount?: number | string
    my_commission?: number | string        // CENTAVOS, líquido de quem recebe o webhook
    currency?: string
    commissioned_stores?: KiwifyCommissionedStore[]
  }
  TrackingParameters?: {
    src?: string | null
    sck?: string | null
    utm_source?: string | null
    utm_medium?: string | null
    utm_campaign?: string | null
    utm_content?: string | null
    utm_term?: string | null
    s1?: string | null
    s2?: string | null
    s3?: string | null
  }
  Subscription?: {
    id?: string
    start_date?: string
    next_payment?: string
    status?: string
    plan?: { id?: string; name?: string; frequency?: string; qty_charges?: number }
  }

  // ── formato CARRINHO ABANDONADO (flat) ──
  id?: string                    // id da sessão de checkout, não é UUID
  status?: string                // 'abandoned'
  name?: string
  email?: string
  phone?: string
  cpf?: string | null
  cnpj?: string | null
  country?: string
  product_id?: string
  product_name?: string
  offer_name?: string
  checkout_link?: string         // apenas o slug, a URL é https://pay.kiwify.com.br/{slug}
  affiliate_id?: string
  store_id?: string
  subscription_plan?: string | null
}

// ─── Log de auditoria (igual aos webhooks Hotmart e Zouti) ───────────────────
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
      source: 'kiwify',
      event: args.event,
      processed: args.processed,
      skipReason: args.skipReason ?? null,
      errorMessage: args.errorMessage ?? null,
      leadId: args.leadId ?? null,
      rawBody: args.rawBody as object,
      headers: args.headers,
    })
  } catch (e) {
    console.error('[webhook_received kiwify insert failed]', e)
  }
}

// Nunca gravamos req.url em lugar nenhum: a query string carrega o nosso ?token=.
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

const paymentTypeMap: Record<string, string> = {
  credit_card: 'credit_card',
  debit_card: 'debit_card',
  boleto: 'boleto',
  pix: 'pix',
  paypal: 'paypal',
}

function mapPaymentType(method: string | undefined | null): string | null {
  if (!method) return null
  const m = method.trim().toLowerCase()
  return paymentTypeMap[m] ?? m
}

// ─── Parser de datas: UM único ponto de entrada ──────────────────────────────
// A Kiwify manda QUATRO formatos diferentes no mesmo payload:
//   pedido:   created_at / updated_at / approved_date  ->  "yyyy-MM-dd HH:mm" (sem fuso)
//   pedido:   boleto_expiry_date                       ->  "dd/MM/yyyy"
//   pedido:   pix_expiration                           ->  "dd/MM/yyyy HH:mm"
//   abandono: created_at                               ->  ISO 8601 COM offset
// Detectar o formato por regex, e não por campo, elimina o risco de aplicar o
// parser errado no campo errado. A função NUNCA lança exceção: devolve null.
const SP_OFFSET = '-03:00'   // fuso presumido America/Sao_Paulo, CALIBRAR com dado real

function parseKiwifyDate(v?: string | null): Date | null {
  try {
    if (!v) return null
    const s = String(v).trim()
    if (!s) return null

    // (1) ISO 8601 já com Z ou offset explícito: confiável, vai direto.
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
      const d = new Date(s.replace(' ', 'T'))
      return isNaN(d.getTime()) ? null : d
    }

    // (2) "yyyy-MM-dd HH:mm" sem fuso: assume America/Sao_Paulo.
    const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/)
    if (m2) {
      const d = new Date(`${m2[1]}-${m2[2]}-${m2[3]}T${m2[4]}:${m2[5]}:${m2[6] ?? '00'}${SP_OFFSET}`)
      return isNaN(d.getTime()) ? null : d
    }

    // (3) "dd/MM/yyyy HH:mm": expiração do PIX.
    const m3 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
    if (m3) {
      const d = new Date(`${m3[3]}-${m3[2]}-${m3[1]}T${m3[4]}:${m3[5]}:${m3[6] ?? '00'}${SP_OFFSET}`)
      return isNaN(d.getTime()) ? null : d
    }

    // (4) "dd/MM/yyyy": vencimento de boleto, vale o dia inteiro, fixa 23:59.
    const m4 = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
    if (m4) {
      const d = new Date(`${m4[3]}-${m4[2]}-${m4[1]}T23:59:00${SP_OFFSET}`)
      return isNaN(d.getTime()) ? null : d
    }

    // (5) Último recurso: deixa o motor tentar. Data inválida vira null.
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d
  } catch {
    return null
  }
}

// ─── Assinatura Kiwify: HMAC-SHA1, hex, do corpo cru, na QUERY STRING ────────
// Confirmado em request real: a Kiwify manda ?signature=<40 hex> e NÃO manda
// nenhum header x-kiwify-*. Não há timestamp assinado, portanto não existe
// anti-replay nativo e não cabe a janela de tolerância que a Zouti tem: a
// proteção contra reenvio é o índice único de dedupe.
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

function verifyKiwifySignature(rawBody: string, signature: string | null, secret: string): { ok: boolean; reason?: string } {
  if (!signature) return { ok: false, reason: 'missing_signature' }
  const expected = crypto.createHmac('sha1', secret).update(rawBody, 'utf8').digest('hex')
  return safeEqualHex(expected, signature.trim().toLowerCase())
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' }
}

// A URL entregue à cliente é ".../api/webhooks/kiwify/<slug>?token=<segredo>",
// porque o painel da Kiwify só aceita URL, não aceita header. Não está
// documentado se a Kiwify concatena a assinatura com "&" (correto) ou com "?"
// (ingênuo). No segundo caso a query vira "?token=X?signature=Y" e o Next
// PERCENT-ENCODA o "?" extra, entregando "?token=X%3Fsignature%3DY". Ou seja,
// trocar "?" por "&" na string crua não resolve, porque já não existe "?" ali.
// Verificado na prática: searchParams.get('token') devolve "X?signature=Y" já
// decodificado, então a assinatura é recuperada de dentro do valor.
// O saneamento equivalente do nosso token está em webhook-auth.ts.
function kiwifySignature(req: NextRequest): string | null {
  const direto = req.nextUrl.searchParams.get('signature')
  if (direto) return direto

  for (const valor of req.nextUrl.searchParams.values()) {
    const achado = valor.match(/[?&]signature=([0-9a-fA-F]{40})/)
    if (achado) return achado[1]
  }

  return req.headers.get('x-kiwify-signature')
}

// ─── Mapeamento de evento ────────────────────────────────────────────────────
type MapResult = { type: string | null; reason?: string }

// O carrinho abandonado não tem webhook_event_type. O payload real usa `status`,
// e o fluxo n8n da cliente também testa `order_status`, por isso os dois.
function isAbandonedPayload(body: KiwifyPayload): boolean {
  const st = (body.status ?? body.order_status ?? '').trim().toLowerCase()
  if (st === 'abandoned') return true
  return body.webhook_event_type == null && body.checkout_link != null
}

function mapEventType(body: KiwifyPayload): MapResult {
  // 1) Abandono antes de tudo: é o único formato sem webhook_event_type.
  if (isAbandonedPayload(body)) return { type: 'carrinho_abandonado' }

  // O sticky note do fluxo n8n escreve "subscription late" e "subscription
  // renewed" com espaço. Não dá para descartar que a Kiwify mande assim, então
  // normalizamos espaços para underscore antes do switch.
  const evt = (body.webhook_event_type ?? '').trim().toLowerCase().replace(/\s+/g, '_')
  const status = (body.order_status ?? '').trim().toLowerCase()
  const method = (body.payment_method ?? '').trim().toLowerCase()

  switch (evt) {
    case 'billet_created':
      // Boleto gerado e não pago.
      return { type: 'boleto' }

    case 'pix_created':
      // PIX gerado e não pago: recuperação própria, separada do boleto.
      return { type: 'pix' }

    case 'order_approved':
      return { type: 'compra_aprovada' }

    case 'order_rejected':
      // Cartão recusado: o evento mais valioso de recuperação.
      return { type: 'cartao_recusado' }

    case 'order_refunded':
    case 'chargeback':
      return { type: 'disputa' }

    case 'subscription_renewed':
      // Cobrança recorrente aprovada: cancela recuperações pendentes do telefone.
      return { type: 'compra_aprovada' }

    case 'subscription_late':
      // Assinatura atrasada: ainda dá para pagar. PIX ou boleto pelo método.
      if (method === 'pix') return { type: 'pix' }
      if (method === 'boleto') return { type: 'boleto' }
      return { type: 'cartao_recusado' }

    case 'subscription_canceled':
      return { type: 'disputa' }

    default:
      break
  }

  // 2) Fallback por order_status, para eventos novos ou payloads sem
  //    webhook_event_type (os payloads de assinatura não têm exemplo real).
  switch (status) {
    case 'paid':
    case 'approved':
      return { type: 'compra_aprovada' }
    case 'waiting_payment':
      if (method === 'pix') return { type: 'pix' }
      if (method === 'boleto') return { type: 'boleto' }
      return { type: 'cartao_recusado' }
    case 'refused':
    case 'canceled':
    case 'cancelled':
      return { type: 'cartao_recusado' }
    case 'refunded':
    case 'refund_requested':
    case 'pending_refund':
    case 'chargedback':
      return { type: 'disputa' }
    default:
      return { type: null, reason: evt ? `evento_desconhecido:${evt}` : `status_desconhecido:${status}` }
  }
}

// ─── Extratores ──────────────────────────────────────────────────────────────
// Duas funções puras devolvendo o MESMO shape, para o processamento não virar
// um emaranhado de ternários entre os dois formatos de payload.
type LeadDraft = {
  transactionId: string | null
  phone: string
  name: string | null
  email: string | null
  cpfCnpj: string | null
  city: string | null
  state: string | null
  country: string | null
  zipcode: string | null
  productId: string | null
  productName: string | null
  productValue: number | null
  paymentType: string | null
  installments: number | null
  boletoCode: string | null
  boletoUrl: string | null
  boletoExpiry: Date | null
  pixCode: string | null
  pixExpiry: Date | null
  checkoutUrl: string | null
  affiliateCode: string | null
  commissionValue: number | null
  trackingSource: string | null
  trackingSourceSck: string | null
  utmMedium: string | null
  utmCampaign: string | null
  utmContent: string | null
  utmTerm: string | null
  orderDate: Date | null
  approvedDate: Date | null
}

// A Kiwify JÁ envia centavos. Esta função NÃO multiplica por 100, só normaliza o
// tipo (os exemplos trazem number, mas commissioned_stores.value vem como string).
function toCents(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? Math.round(n) : null
}

function toInt(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d-]/g, ''))
  return Number.isFinite(n) ? Math.round(n) : null
}

function nonEmpty(v: string | null | undefined): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function draftFromOrder(body: KiwifyPayload): LeadDraft {
  const customer = body.Customer ?? {}
  const commissions = body.Commissions ?? {}
  const utm = body.TrackingParameters ?? {}
  const affiliate = commissions.commissioned_stores?.find((s) => s.type === 'affiliate')

  return {
    transactionId: nonEmpty(body.order_id) ?? nonEmpty(body.order_ref),
    phone: formatBrazilianPhone(customer.mobile ?? ''),
    name: nonEmpty(customer.full_name) ?? nonEmpty(customer.first_name),
    email: nonEmpty(customer.email),
    // O documento vem em Customer.CPF (maiúsculo) ou Customer.cnpj (minúsculo).
    cpfCnpj: nonEmpty(customer.CPF) ?? nonEmpty(customer.cnpj),
    city: nonEmpty(customer.city),
    state: nonEmpty(customer.state),
    country: nonEmpty(customer.country),   // não aparece nos exemplos de pedido, aceita null
    zipcode: nonEmpty(customer.zipcode),
    productId: nonEmpty(body.Product?.product_id),
    productName: nonEmpty(body.Product?.product_name),
    productValue: toCents(commissions.charge_amount), // Kiwify JÁ envia centavos, diferente de Hotmart e Greenn
    paymentType: mapPaymentType(body.payment_method),
    installments: toInt(body.installments),
    boletoCode: nonEmpty(body.boleto_barcode),
    // boleto_URL com U maiúsculo no webhook, boleto_url minúsculo na API REST.
    boletoUrl: nonEmpty(body.boleto_URL) ?? nonEmpty(body.boleto_url),
    boletoExpiry: parseKiwifyDate(body.boleto_expiry_date),
    pixCode: nonEmpty(body.pix_code),
    pixExpiry: parseKiwifyDate(body.pix_expiration),
    checkoutUrl: null,                     // o payload de pedido não traz link de retomada
    affiliateCode: nonEmpty(affiliate?.affiliate_id),
    commissionValue: toCents(commissions.my_commission), // também JÁ em centavos
    trackingSource: nonEmpty(utm.utm_source) ?? nonEmpty(utm.src),
    trackingSourceSck: nonEmpty(utm.sck),
    utmMedium: nonEmpty(utm.utm_medium),
    utmCampaign: nonEmpty(utm.utm_campaign),
    utmContent: nonEmpty(utm.utm_content),
    utmTerm: nonEmpty(utm.utm_term),
    orderDate: parseKiwifyDate(body.created_at),
    approvedDate: parseKiwifyDate(body.approved_date),
  }
}

function draftFromAbandoned(body: KiwifyPayload): LeadDraft {
  const slug = nonEmpty(body.checkout_link)
  return {
    transactionId: nonEmpty(body.id),      // id da sessão de checkout, não é UUID
    phone: formatBrazilianPhone(body.phone ?? ''),
    name: nonEmpty(body.name),
    email: nonEmpty(body.email),
    cpfCnpj: nonEmpty(body.cpf) ?? nonEmpty(body.cnpj),
    city: null,
    state: null,
    country: nonEmpty(body.country),
    zipcode: null,
    productId: nonEmpty(body.product_id),
    productName: nonEmpty(body.product_name),
    productValue: null,                    // o abandono da Kiwify não traz valor nenhum
    paymentType: null,
    installments: null,
    boletoCode: null,
    boletoUrl: null,
    boletoExpiry: null,
    pixCode: null,
    pixExpiry: null,
    // checkout_link é só o slug; a URL de retomada é montada aqui.
    checkoutUrl: slug ? `https://pay.kiwify.com.br/${slug}` : null,
    affiliateCode: nonEmpty(body.affiliate_id),
    commissionValue: null,
    trackingSource: null,                  // o abandono não traz UTM nenhum
    trackingSourceSck: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    orderDate: parseKiwifyDate(body.created_at),
    approvedDate: null,
  }
}

function fmtCurrency(cents: number | null): string {
  if (!cents) return ''
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

type ItemOutcome = 'processed' | 'skipped' | 'duplicate' | 'error'
type ItemResult = { outcome: ItemOutcome; leadId?: number; reason?: string }

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params

  // 1) Barreira própria (nosso token) ANTES de qualquer processamento. Sem log de
  //    propósito, igual Hotmart e Zouti: roda antes de sabermos a empresa, e logar
  //    encheria a tabela com lixo de scanner.
  const headersObj = headersToObject(req)

  const auth = checkWebhookToken(req)
  if (!auth.ok) {
    // As outras plataformas rejeitam aqui em silêncio, para um scanner da
    // internet não encher a tabela de log. Na Kiwify registramos, porque o
    // caminho é o oposto: sem esse registro, uma URL cadastrada sem o
    // "?token=" some sem deixar rastro e o diagnóstico fica impossível.
    // O path completo é específico demais para ser varrido por acaso.
    await logReceived({
      companyId: null, slug, event: null, processed: false,
      skipReason: `auth_falhou:${auth.reason}`,
      rawBody: null, headers: headersObj,
    })
    return NextResponse.json({ error: auth.reason }, { status: auth.status })
  }


  // 2) Corpo CRU antes do parse: a assinatura é calculada sobre ele.
  const rawText = await req.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    await logReceived({
      companyId: null, slug, event: null, processed: false,
      skipReason: 'invalid_json', rawBody: { _raw: rawText.slice(0, 4000) }, headers: headersObj,
    })
    return NextResponse.json({ error: 'Payload inválido' }, { status: 400 })
  }

  const first = (Array.isArray(parsed) ? parsed[0] : parsed) as KiwifyPayload | undefined
  const firstLabel = first?.webhook_event_type ?? first?.status ?? first?.order_status ?? null

  const [company] = await db.select().from(companies).where(eq(companies.slug, slug))
  if (!company) {
    await logReceived({
      companyId: null, slug, event: firstLabel, processed: false,
      skipReason: 'company_not_found', rawBody: parsed, headers: headersObj,
    })
    return NextResponse.json({ error: 'Empresa não encontrada' }, { status: 404 })
  }

  const [config] = await db.select().from(settings).where(eq(settings.companyId, company.id))

  // 3) Assinatura HMAC-SHA1 como camada ADICIONAL: só é exigida quando o segredo
  //    da cliente está configurado, igual Zouti e Greenn.
  if (config?.kiwifyWebhookToken) {
    const signature = kiwifySignature(req)
    const sig = verifyKiwifySignature(rawText, signature, config.kiwifyWebhookToken)
    if (!sig.ok) {
      await logReceived({
        companyId: company.id, slug, event: firstLabel, processed: false,
        skipReason: `invalid_signature:${sig.reason}`, rawBody: parsed, headers: headersObj,
      })
      return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 })
    }
  }

  // 4) O carrinho abandonado pode chegar como ARRAY. Tratamos sempre como lote.
  const events: KiwifyPayload[] = (Array.isArray(parsed) ? parsed : [parsed]) as KiwifyPayload[]
  if (events.length === 0) {
    await logReceived({
      companyId: company.id, slug, event: null, processed: false,
      skipReason: 'empty_batch', rawBody: parsed, headers: headersObj,
    })
    return NextResponse.json({ ok: true, skipped: true, reason: 'empty_batch' })
  }

  const RECOVERY_TYPES = ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado']
  const MIN_FIRST_DELAY_MS = 30 * 60 * 1000

  // Cada item do lote vira uma linha própria em webhook_received e chama
  // logReceived exatamente uma vez.
  async function processEvent(item: KiwifyPayload, index: number, total: number): Promise<ItemResult> {
    const rawForLog: unknown = total > 1 ? { _batchIndex: index, _batchSize: total, ...item } : item
    const eventLabel = item?.webhook_event_type ?? item?.status ?? item?.order_status ?? null

    if (item == null || typeof item !== 'object') {
      await logReceived({
        companyId: company.id, slug, event: null, processed: false,
        skipReason: 'item_nao_e_objeto', rawBody: { _item: String(item), _batchIndex: index }, headers: headersObj,
      })
      return { outcome: 'skipped', reason: 'item_nao_e_objeto' }
    }

    const { type: mappedType, reason: mapReason } = mapEventType(item)
    if (!mappedType) {
      await logReceived({
        companyId: company.id, slug, event: eventLabel, processed: false,
        skipReason: mapReason ?? 'unmapped', rawBody: rawForLog, headers: headersObj,
      })
      return { outcome: 'skipped', reason: mapReason ?? 'unmapped' }
    }

    const draft = isAbandonedPayload(item) ? draftFromAbandoned(item) : draftFromOrder(item)

    const sequences = await db
      .select()
      .from(recoverySequences)
      .where(and(
        eq(recoverySequences.companyId, company.id),
        eq(recoverySequences.eventType, mappedType),
        eq(recoverySequences.isActive, true)
      ))

    // Prioriza sequência com productFilter que combina; fallback para sem filtro.
    const sequence = sequences.find((s) =>
      s.productFilter && (s.productFilter === draft.productId || s.productFilter === draft.productName)
    ) ?? sequences.find((s) => !s.productFilter) ?? null

    let lead: { id: number } | undefined
    try {
      [lead] = await db
        .insert(recoveryLeads)
        .values({
          companyId: company.id,
          platform: 'kiwify',
          eventType: mappedType,
          phone: draft.phone,
          name: draft.name,
          email: draft.email,
          cpfCnpj: draft.cpfCnpj,
          city: draft.city,
          state: draft.state,
          country: draft.country,
          zipcode: draft.zipcode,
          productId: draft.productId,
          productName: draft.productName,
          productValue: draft.productValue,
          priority: eventPriorityMap[mappedType] ?? 0,
          transactionId: draft.transactionId,
          paymentType: draft.paymentType,
          installments: draft.installments,
          boletoCode: draft.boletoCode,
          boletoUrl: draft.boletoUrl,
          boletoExpiry: draft.boletoExpiry,
          pixCode: draft.pixCode,
          pixExpiry: draft.pixExpiry,
          checkoutUrl: draft.checkoutUrl,
          affiliateCode: draft.affiliateCode,
          commissionValue: draft.commissionValue,
          trackingSource: draft.trackingSource,
          trackingSourceSck: draft.trackingSourceSck,
          utmMedium: draft.utmMedium,
          utmCampaign: draft.utmCampaign,
          utmContent: draft.utmContent,
          utmTerm: draft.utmTerm,
          orderDate: draft.orderDate,
          approvedDate: mappedType === 'compra_aprovada' ? (draft.approvedDate ?? draft.orderDate) : draft.approvedDate,
          // A Kiwify não expõe is_order_bump no webhook. Fica sempre false até
          // existir dado real para calibrar.
          isOrderBump: false,
          rawPayload: item,
          status: mappedType === 'compra_aprovada' ? 'completed' : 'pending',
        })
        // Idempotência igual Hotmart e Greenn: cada payload da Kiwify já vem
        // completo, então o merge da Zouti não se aplica e só criaria risco de
        // sobrescrever dado bom com nulo. As fontes de duplicata aqui são o
        // reenvio manual pelo painel e webhooks sobrepostos.
        .onConflictDoNothing({
          target: [recoveryLeads.companyId, recoveryLeads.platform, recoveryLeads.transactionId, recoveryLeads.eventType],
          where: sql`${recoveryLeads.transactionId} is not null`,
        })
        .returning({ id: recoveryLeads.id })
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      await logReceived({
        companyId: company.id, slug, event: eventLabel, processed: false,
        skipReason: 'lead_insert_failed', errorMessage: errMsg,
        rawBody: rawForLog, headers: headersObj,
      })
      return { outcome: 'error', reason: 'lead_insert_failed' }
    }

    if (!lead) {
      await logReceived({
        companyId: company.id, slug, event: eventLabel, processed: false,
        skipReason: 'duplicate_transaction', rawBody: rawForLog, headers: headersObj,
      })
      return { outcome: 'duplicate', reason: 'duplicate_transaction' }
    }

    const leadId = lead.id

    // Cancelar jobs pendentes e marcar como convertido quando chega compra_aprovada.
    if (mappedType === 'compra_aprovada' && draft.phone) {
      const leadsToCancel = await db
        .select({ id: recoveryLeads.id })
        .from(recoveryLeads)
        .where(and(
          eq(recoveryLeads.companyId, company.id),
          eq(recoveryLeads.phone, draft.phone),
          inArray(recoveryLeads.eventType, ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado'])
        ))
      if (leadsToCancel.length > 0) {
        const leadIds = leadsToCancel.map((l) => l.id)
        await db.update(messageJobs).set({ status: 'cancelled' })
          .where(and(inArray(messageJobs.leadId, leadIds), eq(messageJobs.status, 'pending')))

        // Atribuição correta: verifica se alguma mensagem já foi enviada para cada lead.
        for (const cancelledLeadId of leadIds) {
          const [lastSent] = await db
            .select({ messageOrder: messageJobs.messageOrder })
            .from(messageJobs)
            .where(and(eq(messageJobs.leadId, cancelledLeadId), eq(messageJobs.status, 'sent')))
            .orderBy(desc(messageJobs.messageOrder))
            .limit(1)

          const convertedFrom = lastSent?.messageOrder != null
            ? `msg_${lastSent.messageOrder}`
            : 'webhook'

          await db.update(recoveryLeads)
            .set({ status: 'converted', convertedFrom, updatedAt: new Date() })
            .where(eq(recoveryLeads.id, cancelledLeadId))
        }
      }
    }

    const isRecovery = RECOVERY_TYPES.includes(mappedType)
    const now = new Date()

    // Disputa: apenas registra o lead, não envia nada.
    // Sem telefone: grava o lead (serve para analytics e receita) mas NÃO agenda
    // job nenhum, senão o cron criaria mensagem que falha e sujaria o painel.
    // Acontece quando a cliente desabilitou o campo de celular no checkout.
    if (sequence && mappedType !== 'disputa' && draft.phone) {
      const messages = await db
        .select()
        .from(sequenceMessages)
        .where(and(eq(sequenceMessages.sequenceId, sequence.id), eq(sequenceMessages.isActive, true)))
        .orderBy(sequenceMessages.order)

      if (messages.length > 0) {
        await db.insert(messageJobs).values(
          messages.map((msg, i) => {
            let delayMs = (msg.delayMinutes ?? 0) * 60 * 1000
            if (isRecovery && i === 0 && delayMs < MIN_FIRST_DELAY_MS) delayMs = MIN_FIRST_DELAY_MS
            return {
              leadId,
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
          leadId,
          upsellContent: sequence.upsellMessage,
          scheduledFor: new Date(now.getTime() + upsellDelayMs),
          status: 'pending',
          checkBeforeSend: false,
        })
      }
    }

    // Notificação interna (fire-and-forget).
    if (config?.notificationPhone) {
      const label = eventTypeLabels[mappedType] ?? mappedType
      const nome = draft.name ?? 'Desconhecido'
      const produto = draft.productName ?? ''
      const valor = fmtCurrency(draft.productValue)
      const msg = `*${label} (Kiwify)*\nNome: ${nome}\nProduto: ${produto}\nValor: ${valor}\nTel: ${draft.phone}`
      sendWhatsAppMessage(config.notificationPhone, { type: 'text', content: msg }, company.id).catch(() => {})
    }

    await logReceived({
      companyId: company.id, slug, event: eventLabel, processed: true,
      skipReason: draft.phone ? null : 'no_phone_no_schedule',
      leadId, rawBody: rawForLog, headers: headersObj,
    })

    return { outcome: 'processed', leadId }
  }

  const results: ItemResult[] = []
  for (const [index, item] of events.entries()) {
    results.push(await processEvent(item, index, events.length))
  }

  // 500 apenas quando TODOS os itens falharam no banco. Se um entrou e outro
  // falhou, responde 200 para a Kiwify não reenviar o lote inteiro. Evento não
  // mapeado NUNCA vira erro, pelo mesmo motivo.
  const allError = results.every((r) => r.outcome === 'error')
  if (allError) {
    return NextResponse.json({ ok: false, results }, { status: 500 })
  }

  return NextResponse.json({ ok: true, results })
}
