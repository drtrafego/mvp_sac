/**
 * Webhook de conversão do Hermes: fecha o ciclo de otimização de anúncio para
 * empresas cujo "fechamento de venda" é uma reserva/agendamento confirmado
 * por um bot Hermes no WhatsApp (ex.: Gramado Plaza, bot "Gabi"), não um
 * checkout. Espelha os 4 webhooks de checkout (Hotmart/Greenn/Zouti/Kiwify),
 * mas dispara Meta Conversions API com eventName: 'Schedule' em vez de
 * 'Purchase'. Ver plano: operacao/conversao-automatica-lucas-gramado-20260921.md,
 * seção 2. Reaproveita sendConversionEvent() (src/lib/meta-conversions-api.ts)
 * sem alterar hashing/dedup: liga sozinho quando a empresa tiver
 * settings.metaPixelId + metaAdsAccessToken preenchidos.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * CONTRATO EXATO para o lado do bot (reservas_tools.py / uaz_bridge.py do
 * Gramado, ou qualquer outro bot Hermes que confirme reserva/agendamento):
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Chamar isto FIRE-AND-FORGET (nunca bloquear a resposta ao hóspede/cliente,
 * nunca lançar erro pro fluxo de reserva) assim que a reserva for confirmada
 * de verdade (não antes, não em "pendente"):
 *
 *   Método: POST
 *   URL:    https://<host-do-sac>/api/webhooks/hermes/<slug>/conversion
 *           <slug> = companies.slug da empresa no SAC. Para o Gramado Plaza,
 *           CONFIRMAR o valor exato antes de codar (provável "gramado-plaza",
 *           não necessariamente "gramado-plazza" com dois "z" — o nome
 *           comercial e o slug no banco podem divergir).
 *
 *   Headers:
 *     Content-Type: application/json
 *     x-webhook-token: <HERMES_WEBHOOK_SECRET>
 *       Token PRÓPRIO deste webhook, SEPARADO do token dos 4 webhooks de
 *       checkout (achado ALTO do QA, 22/09/2026: este endpoint é chamado por
 *       um script Python num servidor Hetzner externo, superfície de
 *       exposição maior). Pedir o valor real ao time do SAC antes de
 *       configurar o bot (variável de ambiente HERMES_WEBHOOK_SECRET na
 *       Vercel). Enquanto essa env var não existir, o servidor aceita
 *       SAC_WEBHOOK_SECRET como fallback temporário (ver
 *       checkHermesWebhookToken() em src/lib/webhook-auth.ts) — não confiar
 *       nisso a longo prazo, é só pra não travar o deploy. Alternativa
 *       aceita, se o header não for prático de setar:
 *       "?token=<HERMES_WEBHOOK_SECRET>" na querystring da mesma URL.
 *
 *   Body (JSON), UTF-8:
 *   {
 *     "phone":       "5511999998888",  // OBRIGATÓRIO. Só dígitos, com DDI
 *                                       // 55 (mesmo formato que
 *                                       // disparar_crm()/_CRM_PY já usam
 *                                       // pro CRM). Sem isto, 400.
 *     "nome":        "Fulano da Silva",// opcional
 *     "valor":       250.00,           // opcional, EM REAIS (não centavos).
 *                                       // Reserva sem valor definido: omitir
 *                                       // ou mandar null.
 *     "dataReserva": "2026-09-25",     // opcional, formato AAAA-MM-DD
 *     "horario":     "20:00"           // opcional, formato HH:MM, fuso da
 *                                       // casa (America/Sao_Paulo, UTC-3).
 *                                       // Junto com dataReserva vira o
 *                                       // horário do evento de conversão
 *                                       // (event_time da Graph API); se
 *                                       // qualquer um dos dois faltar, usa
 *                                       // o momento em que este webhook foi
 *                                       // recebido.
 *   }
 *
 *   Resposta (sempre volta rápido, em poucos ms — o envio de verdade pro
 *   Meta roda depois, em background, e NUNCA atrasa esta resposta):
 *     200 { "ok": true }                    — aceito, processando em background
 *     400 { "error": "..." }                — JSON inválido ou "phone" ausente
 *     401 { "error": "invalid_webhook_token" } — token ausente ou errado
 *     404 { "error": "Empresa não encontrada" } — <slug> não existe no SAC
 *
 *   Não precisa checar o corpo da resposta além do status: o envio real ao
 *   Meta é fire-and-forget e pode falhar depois (rede, token expirado) sem
 *   que o bot saiba nem precise saber — fica registrado em
 *   meta_conversion_events para retry/auditoria do lado do SAC.
 *
 * Exemplo Python (requests), pensado pra rodar em thread separada dentro do
 * `cmd_reservar`, sem nunca lançar pro chamador:
 *
 *   def _disparar_sac_conversao(cfg, phone, nome, valor, data_reserva, horario):
 *       def _run():
 *           try:
 *               requests.post(
 *                   cfg["sac_webhook"]["url"],
 *                   json={"phone": phone, "nome": nome, "valor": valor,
 *                         "dataReserva": data_reserva, "horario": horario},
 *                   headers={"x-webhook-token": cfg["sac_webhook"]["token"]},
 *                   timeout=5,
 *               )
 *           except Exception:
 *               pass
 *       threading.Thread(target=_run, daemon=True).start()
 *
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Nota de escopo (22/09/2026, atualizada na rodada de correções do QA): esta
 * implementação usa um token GLOBAL próprio deste endpoint
 * (checkHermesWebhookToken()/HERMES_WEBHOOK_SECRET, com fallback pra
 * SAC_WEBHOOK_SECRET só até a env var nova ser configurada na Vercel), não
 * mais o mesmo secret dos 4 webhooks de checkout, e não um token por
 * empresa. O plano técnico do dia 21/09 (seção 4) havia cogitado um campo
 * novo `settings.hermesWebhookToken` por empresa; isso NÃO foi implementado
 * aqui (não pedido nesta rodada) e fica como possível reforço futuro, não
 * bloqueante.
 */

import { NextRequest, NextResponse, after } from 'next/server'
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { companies, metaConversionEvents, recoveryLeads, webhookReceived } from '@/lib/db/schema'
import { formatBrazilianPhone } from '@/lib/whatsapp'
import { checkHermesWebhookToken } from '@/lib/webhook-auth'
import { maskedHeaders } from '@/lib/webhook-headers'
import { scheduleEventId, sendConversionEvent } from '@/lib/meta-conversions-api'

// Janela de reaproveitamento de evento pendente/enviado quando o event_id
// cai no fallback não determinístico (ver resolveEventTime() e FIX 2 dentro
// do POST abaixo). 15min é generoso o bastante pra cobrir retry de rede do
// bot sem risco de reaproveitar um evento de uma reserva seguinte de
// verdade do mesmo hóspede.
const RECENT_EVENT_REUSE_WINDOW_MS = 15 * 60 * 1000

type HermesConversionPayload = {
  phone?: string
  nome?: string
  valor?: number | null
  dataReserva?: string
  horario?: string
  acao?: 'created' | 'updated' | 'cancelled' | 'criada' | 'atualizada' | 'cancelada'
  reservaId?: string
  status?: string
}

function reservationAction(body: HermesConversionPayload): 'created' | 'updated' | 'cancelled' {
  const action = (body.acao || 'created').toLowerCase()
  if (action === 'updated' || action === 'atualizada') return 'updated'
  if (action === 'cancelled' || action === 'cancelada') return 'cancelled'
  return 'created'
}

async function logReceived(args: {
  companyId: number | null
  slug: string
  processed: boolean
  skipReason?: string | null
  errorMessage?: string | null
  leadId?: number | null
  event?: string
  rawBody: unknown
  headers: Record<string, string>
}) {
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('timeout'), 500))
  const dbPromise = (async () => {
    try {
      await db.insert(webhookReceived).values({
        companyId: args.companyId,
        slug: args.slug,
        source: 'hermes',
        event: args.event || 'reserva_confirmada',
        processed: args.processed,
        skipReason: args.skipReason ?? null,
        errorMessage: args.errorMessage ?? null,
        leadId: args.leadId ?? null,
        rawBody: args.rawBody as object,
        headers: args.headers,
      })
    } catch (e) {
      console.error('[webhook_received hermes insert failed]', e)
    }
  })()

  try {
    const res = await Promise.race([dbPromise, timeoutPromise])
    if (res === 'timeout') {
      console.warn('[webhook_received hermes timeout] gravação de log em background excedeu 500ms, liberando resposta')
    }
  } catch (e) {
    console.error('[logReceived error]', e)
  }
}

// "AAAA-MM-DD" + "HH:MM" no fuso da casa (America/Sao_Paulo, UTC-3 o ano
// todo, sem horário de verão desde 2019) -> Date real. Falta um dos dois, ou
// vem inválido: usa o momento em que o webhook chegou (mesmo espírito do
// "latência de até ~25min é irrelevante" já registrado no plano técnico,
// seção 1.3 — aqui a diferença é minutos, não horas).
//
// `deterministic: false` sinaliza pro POST abaixo que o tempo usado é
// new Date() (muda a cada chamada) e por isso scheduleEventId() NÃO produz o
// mesmo event_id em dois retries do mesmo evento (FIX 2, achado CRÍTICO do
// QA em 22/09/2026: sem essa sinalização, um retry do bot sem
// dataReserva/horario furava a dedup de evento no Meta a cada tentativa).
function resolveEventTime(dataReserva?: string, horario?: string): { time: Date; deterministic: boolean } {
  if (dataReserva && horario) {
    const d = new Date(`${dataReserva}T${horario}:00-03:00`)
    if (!isNaN(d.getTime())) return { time: d, deterministic: true }
  }
  return { time: new Date(), deterministic: false }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await params

  // Barreira própria (nosso token) ANTES de qualquer processamento. Token
  // PRÓPRIO deste webhook desde 22/09/2026 (FIX 3, achado ALTO do QA):
  // checkHermesWebhookToken() (não o checkWebhookToken() dos 4 webhooks de
  // checkout), ver src/lib/webhook-auth.ts.
  const auth = checkHermesWebhookToken(req)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status })
  }

  const headersObj = maskedHeaders(req)

  const rawText = await req.text()
  let body: HermesConversionPayload
  try {
    body = rawText ? (JSON.parse(rawText) as HermesConversionPayload) : {}
  } catch {
    await logReceived({
      companyId: null, slug, processed: false,
      skipReason: 'invalid_json', rawBody: { _raw: rawText.slice(0, 4000) }, headers: headersObj,
    })
    return NextResponse.json({ error: 'Payload inválido' }, { status: 400 })
  }

  const [company] = await db.select().from(companies).where(eq(companies.slug, slug))
  if (!company) {
    await logReceived({
      companyId: null, slug, processed: false,
      skipReason: 'company_not_found', rawBody: body, headers: headersObj,
    })
    return NextResponse.json({ error: 'Empresa não encontrada' }, { status: 404 })
  }

  const phoneRaw = (body.phone || '').trim()
  if (!phoneRaw) {
    await logReceived({
      companyId: company.id, slug, processed: false,
      skipReason: 'missing_phone', rawBody: body, headers: headersObj,
    })
    return NextResponse.json({ error: 'phone é obrigatório' }, { status: 400 })
  }
  const phone = formatBrazilianPhone(phoneRaw)
  const action = reservationAction(body)
  const webhookEvent = action === 'cancelled'
    ? 'reserva_cancelada'
    : action === 'updated'
      ? 'reserva_atualizada'
      : 'reserva_confirmada'

  // FIX 4 (MÉDIO, QA 22/09/2026): phoneRaw truthy não significa telefone
  // válido — uma string tipo "N/A" passava pelo check acima. Um telefone
  // brasileiro formatado (formatBrazilianPhone) sempre tem 13 dígitos
  // (55 + DDD + 9 dígitos); 12 é a margem mínima aceita (cobre também os
  // poucos casos de DDI de outro país que a função devolve como veio, sem
  // normalizar). Abaixo disso não dá pra hashear um telefone real pro Meta.
  if (phone.replace(/\D/g, '').length < 12) {
    await logReceived({
      companyId: company.id, slug, processed: false,
      skipReason: 'invalid_phone', rawBody: body, headers: headersObj,
    })
    return NextResponse.json({ error: 'phone inválido' }, { status: 400 })
  }

  const { time: eventTime, deterministic: eventTimeDeterministic } = resolveEventTime(body.dataReserva, body.horario)

  // Resolve/cria lead por telefone: REAPROVEITA o lead existente (a mesma
  // conversa do bot no WhatsApp já deve ter um) sem mexer nos campos de
  // atendimento dele (nome, mensagens, responsável). Só cria um registro
  // mínimo quando de fato não existe nenhum lead com este telefone nesta
  // empresa.
  //
  // pipelineStage É a exceção deliberada (22/09/2026, achado do Gastão: a
  // tela de Pipeline nunca mostrava reserva/agendamento pra Dr. Lucas e
  // Gramado Plaza). Os leads destas duas empresas nascem no bloco 3 de
  // sync-agents.ts (conversa do agente IA) com status FIXO 'in_conversation'
  // e sem pipelineStage — o fallback heurístico do Pipeline
  // (src/app/(dashboard)/pipeline/page.tsx) não reconhece esse status nem o
  // eventType 'reserva_confirmada', então o card ficava preso em "Novo
  // Contato" pra sempre, mesmo com a reserva confirmada de verdade. Este
  // webhook é o único ponto do sistema que sabe que uma reserva foi
  // confirmada, então é ele quem grava pipelineStage = 'agendado' (estágio
  // "Agendado / Reserva" do Kanban, já usado como sinônimo de reserva
  // confirmada em src/app/(dashboard)/page.tsx). Só ESSE campo é tocado;
  // nunca sobrescreve um card que um humano já arrastou pra 'fechado'
  // manualmente (ver o UPDATE logo após o resolve do leadId, abaixo).
  //
  // FIX 1 (CRÍTICO, QA 22/09/2026): o SELECT-então-INSERT de antes deixava
  // uma corrida entre requisições concorrentes com o mesmo telefone novo —
  // QA reproduziu ao vivo, 2 requisições concorrentes → 2 leads. Trocado por
  // INSERT ... ON CONFLICT DO NOTHING (mesmo índice único parcial que
  // whatsapp/instagram usam, agora ampliado pra incluir 'hermes' em
  // recovery_leads_chat_company_phone_unique, ver schema.ts +
  // drizzle/0010_recovery_leads_hermes_dedup.sql) seguido de SELECT só
  // quando vier vazio (perdeu a corrida pra outra requisição concorrente).
  // DO NOTHING em vez do DO UPDATE que whatsapp/instagram usam de propósito:
  // aqui a regra é NUNCA tocar em nenhum campo de um lead que já existe, e
  // DO UPDATE forçaria um SET mesmo que "vazio".
  let leadId: number | null = null
  try {
    const [inserted] = await db
      .insert(recoveryLeads)
      .values({
        companyId: company.id,
        platform: 'hermes',
        eventType: webhookEvent,
        phone,
        name: body.nome || null,
        channel: 'whatsapp',
        status: action === 'cancelled' ? 'cancelled' : 'completed',
        rawPayload: body,
      })
      .onConflictDoNothing({
        target: [recoveryLeads.companyId, recoveryLeads.phone],
        where: sql`${recoveryLeads.platform} in ('instagram', 'sac', 'hermes')`,
      })
      .returning({ id: recoveryLeads.id })

    if (inserted) {
      leadId = inserted.id
    } else {
      // Conflito: já existe lead pra este telefone+empresa (reserva
      // repetida do mesmo hóspede, ou a corrida com outra requisição
      // concorrente que ganhou primeiro). Busca sem alterar nada.
      const [existing] = await db
        .select({ id: recoveryLeads.id })
        .from(recoveryLeads)
        .where(and(eq(recoveryLeads.companyId, company.id), eq(recoveryLeads.phone, phone)))
        .orderBy(desc(recoveryLeads.id))
        .limit(1)
      leadId = existing?.id ?? null
    }
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    await logReceived({
      companyId: company.id, slug, processed: false,
      skipReason: 'lead_resolve_failed', errorMessage: errMsg, rawBody: body, headers: headersObj,
    })
    return NextResponse.json({ error: 'Falha ao gravar lead' }, { status: 500 })
  }

  if (leadId == null) {
    await logReceived({
      companyId: company.id, slug, processed: false,
      skipReason: 'lead_resolve_no_id', rawBody: body, headers: headersObj,
    })
    return NextResponse.json({ error: 'Falha ao gravar lead' }, { status: 500 })
  }

  // Criação/atualização mantém a reserva em Agendado. Cancelamento
  // chega no mesmo endpoint, mas marca o lead como cancelado/perdido e nunca
  // dispara uma nova conversão para a Meta.
  // (roda em toda reserva confirmada, inclusive retries) e nunca regride um
  // card que já está em 'fechado' — esse estágio final só é decisão manual
  // de quem usa o Kanban, o bot nunca sabe de fechamento de venda de verdade.
  try {
    await db
      .update(recoveryLeads)
      .set({
        pipelineStage: action === 'cancelled' ? 'perdido' : 'agendado',
        status: action === 'cancelled' ? 'cancelled' : 'completed',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(recoveryLeads.id, leadId),
          action === 'cancelled'
            ? sql`true`
            : sql`(${recoveryLeads.pipelineStage} is null or ${recoveryLeads.pipelineStage} <> 'fechado')`,
        ),
      )
  } catch (e) {
    console.error('[hermes-conversion] falha ao atualizar pipelineStage:', e)
  }

  // FIX 2 (CRÍTICO, QA 22/09/2026): quando falta dataReserva/horario,
  // resolveEventTime() cai no fallback "agora" (não determinístico) — cada
  // retry do bot pro MESMO evento geraria um event_id novo
  // (scheduleEventId inclui o timestamp), driblando o
  // uniqueIndex(companyId, eventId) de meta_conversion_events e furando a
  // dedup de conversão no Meta a cada tentativa. Nesses casos, ANTES de
  // disparar, procura um evento 'pending'/'sent' recente (mesma
  // empresa+lead+eventName, dentro de RECENT_EVENT_REUSE_WINDOW_MS) e, se
  // existir, reaproveita: é retry do mesmo evento, não um evento novo, então
  // pula o envio (nunca dispara pro Meta de novo, nunca sobrescreve o
  // event_id já gravado). Quando dataReserva+horario vêm válidos, o
  // event_id já é determinístico e a proteção de sempre
  // (uniqueIndex+isUniqueViolation em sendConversionEvent) já resolve.
  let skipEventDispatch = action !== 'created'
  const eventId = scheduleEventId(company.id, leadId, eventTime)
  if (!eventTimeDeterministic) {
    const [recentEvent] = await db
      .select({ id: metaConversionEvents.id })
      .from(metaConversionEvents)
      .where(
        and(
          eq(metaConversionEvents.companyId, company.id),
          eq(metaConversionEvents.leadId, leadId),
          eq(metaConversionEvents.eventName, 'Schedule'),
          inArray(metaConversionEvents.status, ['pending', 'sent']),
          gte(metaConversionEvents.createdAt, new Date(Date.now() - RECENT_EVENT_REUSE_WINDOW_MS)),
        ),
      )
      .orderBy(desc(metaConversionEvents.createdAt))
      .limit(1)

    if (recentEvent) {
      skipEventDispatch = true
    }
  }

  // Meta Conversions API: evento Schedule fire-and-forget, roda DEPOIS do 200
  // sair pro bot (after(), mesmo padrão dos webhooks de checkout) e nunca
  // atrasa nem derruba este webhook. Fica mudo sozinho se a empresa não
  // configurou settings.metaPixelId/metaAdsAccessToken (ver
  // src/lib/meta-conversions-api.ts). skipEventDispatch (FIX 2) pula o
  // envio quando é retry do mesmo evento não determinístico já em voo.
  if (!skipEventDispatch) {
    after(() =>
      sendConversionEvent({
        companyId: company.id,
        leadId,
        eventName: 'Schedule',
        eventId,
        phone,
        value: body.valor ?? null,
        currency: 'BRL',
        eventTime,
      }).catch((err) => console.error('[meta-capi] erro no after() do webhook Hermes:', err)),
    )
  }

  await logReceived({
    companyId: company.id, slug, processed: true, leadId,
    event: webhookEvent,
    skipReason: action !== 'created'
      ? `schedule_event_not_applicable_${action}`
      : skipEventDispatch ? 'schedule_event_retry_deduped' : null,
    rawBody: body, headers: headersObj,
  })

  return NextResponse.json({ ok: true })
}
