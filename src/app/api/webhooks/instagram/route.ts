// generateAndSendAiReply roda via after() e chama a ponte de IA, que tem
// timeout de 150s (TIMEOUT_MS em src/lib/ai/ai-bridge.ts). Sem maxDuration
// explícito, o default da Vercel pode matar a function antes disso e o
// finally que libera o lock de concorrência nunca roda.
export const maxDuration = 180

import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { db } from "@/lib/db"
import { companies, settings, whatsappMessages, webhookReceived, recoveryLeads } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"
import { maskedHeaders } from "@/lib/webhook-headers"
import { verifyMetaSignature } from "@/lib/meta-signature"
import { processInstagramComment } from "@/lib/instagram-comment-processor"
import { markLeadContacted } from "@/lib/leads"
import { generateAndSendAiReply } from "@/lib/ai-reply"
import { isInboundMessageAlreadyProcessed, isUniqueViolation } from "@/lib/webhook-dedup"

// Resolve a empresa dona de um pageId (Instagram Account ID ou Page ID) e,
// junto, o slug dela pra registrar em webhook_received (mesmo padrão de log
// que a rota [slug] já grava sempre, ver POST abaixo).
async function resolveCompanyForPageId(pageId: string): Promise<{ companyId: number; slug: string } | null> {
  const [byAccountId] = await db
    .select({ companyId: settings.companyId, slug: companies.slug })
    .from(settings)
    .innerJoin(companies, eq(companies.id, settings.companyId))
    .where(eq(settings.instagramAccountId, pageId))
    .limit(1)
  if (byAccountId) return byAccountId

  const [byPageId] = await db
    .select({ companyId: settings.companyId, slug: companies.slug })
    .from(settings)
    .innerJoin(companies, eq(companies.id, settings.companyId))
    .where(eq(settings.instagramPageId, pageId))
    .limit(1)
  return byPageId ?? null
}

// Extrai o pageId do primeiro entry, só pra resolver qual empresa validar o
// segredo, ANTES de qualquer outro processamento do payload.
function extractFirstPageIdForSecret(body: Record<string, unknown>): string | null {
  if (body.object !== 'instagram' || !Array.isArray(body.entry)) return null
  for (const entry of body.entry as Record<string, unknown>[]) {
    const pageId = entry.id as string | undefined
    if (pageId) return pageId
  }
  return null
}

/**
 * GET - Global Meta Instagram Webhook verification handshake
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get("hub.mode")
  const token = searchParams.get("hub.verify_token")
  const challenge = searchParams.get("hub.challenge")

  if (mode === "subscribe" && token && (token === process.env.META_VERIFY_TOKEN || token === process.env.INSTAGRAM_VERIFY_TOKEN)) {
    return new NextResponse(challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }

  // Verifica se o token pertence a alguma empresa
  if (token) {
    const [found] = await db.select().from(settings).where(eq(settings.instagramVerifyToken, token))
    if (found && mode === "subscribe") {
      return new NextResponse(challenge ?? "", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    }
  }

  return new NextResponse("Token de verificação inválido", { status: 403 })
}

/**
 * POST - Global Instagram message receiver
 */
export async function POST(req: NextRequest) {
  let rawBodyText = ""
  let rawBody: Record<string, unknown> = {}
  try {
    rawBodyText = await req.text()
    rawBody = JSON.parse(rawBodyText) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  // Validação da assinatura x-hub-signature-256 da Meta: falha fechada, nunca aceita sem checagem.
  // ‼️ 23/09/2026: o app do Instagram (Instagram API with Instagram Login, sem
  // Página do Facebook) tem App Secret PRÓPRIO, diferente do app principal
  // (WhatsApp). Usar metaAppSecret aqui rejeitava TODO webhook real do
  // Instagram com 401, mesmo com tudo mais configurado certo. Ordem: secret
  // do Instagram da empresa > secret do Instagram global > secret do app
  // principal da empresa (compat) > secret do app principal global (compat).
  let companySecret: string | null = null
  let companyMetaSecret: string | null = null
  const pageIdForSecret = extractFirstPageIdForSecret(rawBody)
  if (pageIdForSecret) {
    let [matchedForSecret] = await db.select().from(settings).where(eq(settings.instagramAccountId, pageIdForSecret)).limit(1)
    if (!matchedForSecret) {
      const [byPageId] = await db.select().from(settings).where(eq(settings.instagramPageId, pageIdForSecret)).limit(1)
      matchedForSecret = byPageId
    }
    companySecret = matchedForSecret?.instagramAppSecret ?? null
    companyMetaSecret = matchedForSecret?.metaAppSecret ?? null
  }
  const secret =
    companySecret ||
    process.env.INSTAGRAM_APP_SECRET ||
    companyMetaSecret ||
    process.env.META_APP_SECRET
  if (!secret) {
    console.error("[Instagram Webhook] Nenhum App Secret configurado (nem da empresa, nem o compartilhado), recusando requisição")
    return NextResponse.json({ error: "meta_app_secret_not_configured" }, { status: 503 })
  }
  const sigHeader = req.headers.get("x-hub-signature-256")
  if (!sigHeader || !verifyMetaSignature(rawBodyText, sigHeader, secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 })
  }

  const headersObj = maskedHeaders(req)

  try {
    if (rawBody.object === 'instagram' && Array.isArray(rawBody.entry)) {
      for (const entry of rawBody.entry as Record<string, unknown>[]) {
        // Cada entry roda isolado: uma exceção aqui (ex.: entry malformado de
        // uma empresa) não pode abortar o processamento dos entries seguintes
        // no mesmo payload, que podem ser de empresas totalmente diferentes
        // sem nenhuma relação com o erro (achado do QA, 2ª rodada).
        try {
        const pageId = (entry.id as string) || ''
        const messagingList = (entry.messaging as Record<string, unknown>[]) ?? []

        // Encontra a empresa correspondente pelo instagramAccountId ou instagramPageId
        const resolved = await resolveCompanyForPageId(pageId)
        const companyId = resolved?.companyId ?? null

        // Registra o webhook_received pra ESTE entry, tanto no sucesso quanto
        // na falha de resolução: antes disso a rota global nunca gravava
        // nada aqui (só a rota [slug] gravava sempre), e uma empresa não
        // resolvida virava silent fail total, sem log e sem linha no banco.
        try {
          await db.insert(webhookReceived).values({
            companyId,
            slug: resolved?.slug ?? null,
            source: "instagram",
            event: (rawBody.object as string) || "instagram_direct",
            processed: !!companyId,
            skipReason: companyId
              ? null
              : `empresa não resolvida pelo instagramAccountId/instagramPageId do payload (pageId=${pageId})`,
            rawBody: entry,
            headers: headersObj,
          })
        } catch (logErr) {
          console.error("[Instagram Webhook Global] Erro ao registrar webhook_received:", logErr)
        }

        if (!companyId) {
          console.error(`[Instagram Webhook Global] empresa não resolvida pelo instagramAccountId/instagramPageId do payload (pageId=${pageId}), evento descartado`)
        }

        if (companyId) {
          // 1. Mensagens diretas (DM). Cada item roda isolado: uma exceção
          // num item (mensagem malformada, erro pontual de banco) não pode
          // abortar os itens seguintes do mesmo batch, mesmo os de outros
          // remetentes (achado do QA, 2ª rodada; mesmo padrão que a rota
          // [slug] já usa).
          for (const item of messagingList) {
            const sender = item.sender as { id?: string } | undefined
            const message = item.message as { mid?: string; text?: string } | undefined
            if (sender?.id && message?.text) {
              try {
                // Idempotência contra reentrega de webhook da Meta: reentrega é
                // comportamento real dela, não hipotético. Sem isso, o mesmo
                // evento reentregue grava duas linhas inbound iguais e dispara
                // DUAS respostas reais de IA pro mesmo cliente pra mesma mensagem.
                if (await isInboundMessageAlreadyProcessed(companyId, message.mid)) {
                  console.log(`[Instagram Webhook Global] mensagem já processada (reentrega da Meta), mid=${message.mid}, pulando`)
                  continue
                }

                const igPhone = `ig_${sender.id}`

                // Upsert atômico: SELECT-então-INSERT deixava uma janela de
                // corrida entre duas requisições concorrentes com o mesmo
                // telefone novo, e cada uma criava um lead próprio (provado
                // pelo QA ao vivo: 10 requisições concorrentes → 6 leads
                // distintos pro mesmo telefone). O índice único parcial
                // recovery_leads_chat_company_phone_unique (ver schema.ts)
                // fecha essa corrida no banco.
                const [lead] = await db
                  .insert(recoveryLeads)
                  .values({
                    companyId,
                    platform: 'instagram',
                    channel: 'instagram',
                    eventType: 'instagram_direct',
                    phone: igPhone,
                    name: `Instagram Direct (${sender.id.slice(-4)})`,
                    status: 'in_conversation',
                    trackingSource: 'instagram_direct',
                  })
                  .onConflictDoUpdate({
                    target: [recoveryLeads.companyId, recoveryLeads.phone],
                    // Precisa bater EXATAMENTE com o WHERE do índice
                    // recovery_leads_chat_company_phone_unique (schema.ts) pro
                    // Postgres inferir o arbiter do ON CONFLICT. Ampliado pra
                    // incluir 'hermes' em 22/09/2026 junto com a migration
                    // 0010 (fix de concorrência no webhook de conversão do
                    // Hermes) — mudou lá, muda aqui também.
                    targetWhere: sql`${recoveryLeads.platform} in ('instagram', 'sac', 'hermes')`,
                    // lastActionAt precisa entrar aqui: o COALESCE de
                    // ordenação do Inbox (lastActionAt, updatedAt, createdAt)
                    // trava no primeiro valor não nulo, então um lead que já
                    // tem lastActionAt de qualquer origem anterior nunca subia
                    // na lista quando chegava DM nova, mesmo com updatedAt
                    // fresco.
                    set: { updatedAt: new Date(), lastActionAt: new Date(), channel: 'instagram' },
                  })
                  .returning()

                try {
                  await db.insert(whatsappMessages).values({
                    companyId,
                    leadId: lead?.id ?? null,
                    phone: igPhone,
                    channel: 'instagram',
                    direction: 'inbound',
                    content: message.text,
                    messageType: 'text',
                    sentBy: 'user',
                    externalId: message.mid ?? null,
                  })
                } catch (err) {
                  // Segunda camada (índice único parcial): corrida entre duas
                  // requisições concorrentes que passaram pelo SELECT acima ao
                  // mesmo tempo. Já processado, não é erro fatal.
                  if (isUniqueViolation(err)) {
                    console.log(`[Instagram Webhook Global] corrida no insert (unique violation), mid=${message.mid}, tratando como já processado`)
                    continue
                  }
                  throw err
                }

                // Mensagem real trocada: se for a primeira, marca a abordagem do lead
                await markLeadContacted(lead?.id)

                // Resposta automática de IA (Fase 1): mesmo motor do WhatsApp, só
                // muda o canal de envio (decidido dentro de generateAndSendAiReply
                // pelo lead.channel). Roda depois do 200 sair, nunca atrasa o
                // webhook. Respeita botPaused e o gate de aiSystemPrompt.
                if (lead?.id && !lead.botPaused) {
                  const leadId = lead.id
                  after(() =>
                    generateAndSendAiReply(leadId).catch((err) =>
                      console.error('[AI Reply] erro no after() do webhook Instagram:', err),
                    ),
                  )
                }
              } catch (itemErr) {
                console.error(`[Instagram Webhook Global] Erro ao processar mensagem (mid=${message?.mid}):`, itemErr)
              }
            }
          }

          // 2. Comentários em Posts/Reels (Comentário vira DM)
          const changesList = (entry.changes as Record<string, unknown>[]) ?? []
          for (const change of changesList) {
            if (change.field === 'comments' && change.value) {
              const val = change.value as Record<string, unknown>
              const commentId = (val.id as string) || ''
              const commentText = (val.text as string) || ''
              const fromObj = val.from as { id?: string; username?: string } | undefined
              const commenterId = fromObj?.id || ''
              const commenterUsername = fromObj?.username
              const mediaObj = val.media as { id?: string } | undefined
              const mediaId = mediaObj?.id || (val.media_id as string) || ''

              if (commentId && commenterId && commentText) {
                await processInstagramComment({
                  companyId,
                  commentId,
                  commenterId,
                  commenterUsername,
                  mediaId,
                  commentText,
                }).catch(err => console.error('[Comment-to-DM Webhook Global Error]:', err))
              }
            }
          }
        }
        } catch (entryErr) {
          console.error(`[Instagram Webhook Global] Erro ao processar entry (pageId=${(entry as Record<string, unknown>)?.id}):`, entryErr)
        }
      }
    }
  } catch (err) {
    console.error('[Global Instagram Webhook Error]:', err)
  }

  return NextResponse.json({ success: true })
}