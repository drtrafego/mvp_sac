// generateAndSendAiReply roda via after() e chama a ponte de IA, que tem
// timeout de 150s (TIMEOUT_MS em src/lib/ai/ai-bridge.ts). Sem maxDuration
// explícito, o default da Vercel pode matar a function antes disso e o
// finally que libera o lock de concorrência nunca roda.
export const maxDuration = 180

import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { db } from "@/lib/db"
import { companies, settings, whatsappMessages, recoveryLeads, webhookReceived, leadTags } from "@/lib/db/schema"
import { and, eq, sql } from "drizzle-orm"
import { maskedHeaders } from "@/lib/webhook-headers"
import { verifyMetaSignature } from "@/lib/meta-signature"
import { processInstagramComment, handleFollowCheckReply } from "@/lib/instagram-comment-processor"
import { fetchInstagramUserProfile } from "@/lib/instagram"
import { markLeadContacted } from "@/lib/leads"
import { generateAndSendAiReply } from "@/lib/ai-reply"
import { isInboundMessageAlreadyProcessed, isUniqueViolation } from "@/lib/webhook-dedup"


function instagramDebugPayload(opts: {
  entry?: Record<string, unknown>
  item?: Record<string, unknown>
  pageId?: string
  companyId?: number | null
  slug?: string | null
  senderId?: string | null
  recipientId?: string | null
  mid?: string | null
  text?: string | null
  isEcho?: boolean
  attachmentTypes?: string[]
  referral?: unknown
  isAd?: boolean
  trackingSource?: string
  leadId?: number | null
  decision?: string
  reason?: string | null
}) {
  return {
    entry: opts.entry,
    item: opts.item,
    debug: {
      source: 'instagram',
      pageId: opts.pageId ?? null,
      companyId: opts.companyId ?? null,
      slug: opts.slug ?? null,
      senderId: opts.senderId ?? null,
      recipientId: opts.recipientId ?? null,
      mid: opts.mid ?? null,
      hasText: Boolean(opts.text && opts.text.trim()),
      textPreview: opts.text ? opts.text.slice(0, 500) : null,
      isEcho: Boolean(opts.isEcho),
      attachmentTypes: opts.attachmentTypes ?? [],
      referral: opts.referral ?? null,
      isAd: Boolean(opts.isAd),
      trackingSource: opts.trackingSource ?? null,
      leadId: opts.leadId ?? null,
      decision: opts.decision ?? null,
      reason: opts.reason ?? null,
      loggedAt: new Date().toISOString(),
    },
  }
}

interface RouteContext {
  params: Promise<{ slug: string }>
}

/**
 * GET - Handshake de verificação do Webhook da Meta (Instagram Messaging)
 */
export async function GET(req: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const { searchParams } = new URL(req.url)
  const mode = searchParams.get("hub.mode")
  const token = searchParams.get("hub.verify_token")
  const challenge = searchParams.get("hub.challenge")

  if (!mode || !token) {
    return new NextResponse("Parâmetros inválidos", { status: 400 })
  }

  const [company] = await db.select().from(companies).where(eq(companies.slug, slug))
  if (!company) {
    return new NextResponse("Empresa não encontrada", { status: 404 })
  }

  const [companySettings] = await db.select().from(settings).where(eq(settings.companyId, company.id))
  const expectedToken = companySettings?.instagramVerifyToken || companySettings?.metaVerifyToken || process.env.META_VERIFY_TOKEN

  if (mode === "subscribe" && token === expectedToken) {
    return new NextResponse(challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }

  return new NextResponse("Token de verificação inválido", { status: 403 })
}

/**
 * POST - Recebimento de eventos e mensagens diretas do Instagram via Meta Graph API
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const [company] = await db.select().from(companies).where(eq(companies.slug, slug))
  if (!company) {
    return NextResponse.json({ error: "Empresa não encontrada" }, { status: 404 })
  }

  const headersObj = maskedHeaders(req)
  let rawBodyText = ""
  let rawBody: Record<string, unknown> = {}
  try {
    rawBodyText = await req.text()
    rawBody = JSON.parse(rawBodyText) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Payload JSON inválido" }, { status: 400 })
  }

  // Validação da assinatura x-hub-signature-256 da Meta: falha fechada, nunca aceita sem checagem.
  // Empresa já foi resolvida pelo slug acima. ‼️ 23/09/2026: o app do Instagram
  // tem App Secret PRÓPRIO, diferente do app principal (WhatsApp) — mesma
  // causa raiz corrigida na rota global (route.ts um nível acima).
  const [companySettingsForSecret] = await db.select().from(settings).where(eq(settings.companyId, company.id))
  const secret =
    companySettingsForSecret?.instagramAppSecret ||
    process.env.INSTAGRAM_APP_SECRET ||
    companySettingsForSecret?.metaAppSecret ||
    process.env.META_APP_SECRET
  if (!secret) {
    console.error("[Instagram Webhook] Nenhum App Secret configurado (nem da empresa, nem o compartilhado), recusando requisição")
    return NextResponse.json({ error: "meta_app_secret_not_configured" }, { status: 503 })
  }
  const sigHeader = req.headers.get("x-hub-signature-256")
  if (!sigHeader || !verifyMetaSignature(rawBodyText, sigHeader, secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 })
  }

  try {
    await db.insert(webhookReceived).values({
      companyId: company.id,
      slug,
      source: "instagram",
      event: (rawBody.object as string) || "instagram_direct",
      processed: true,
      rawBody,
      headers: headersObj,
    })
  } catch (err) {
    console.error("[Instagram Webhook] Erro ao registrar webhook_received:", err)
  }

  if (rawBody.object === "instagram" && Array.isArray(rawBody.entry)) {
    for (const entry of rawBody.entry as Record<string, unknown>[]) {
      const messagingList = (entry.messaging as Record<string, unknown>[]) ?? []
      for (const item of messagingList) {
        const sender = item.sender as { id?: string } | undefined
        const message = item.message as {
          mid?: string
          text?: string
          is_echo?: boolean
          attachments?: Array<{ type?: string; payload?: Record<string, unknown> }>
          referral?: Record<string, unknown>
        } | undefined
        const recipient = item.recipient as { id?: string } | undefined
        const ownAccountIds = [companySettingsForSecret?.instagramAccountId, companySettingsForSecret?.instagramPageId].filter(Boolean)

        // ‼️ Checagem de anexo/partilha (24/09/2026): quando alguém compartilha post/reel
        // ou manda mídia, a Meta manda `attachments`. Se tiver anexos, ignoramos o processamento
        // de IA (não é pergunta/conversa de texto, mesmo que venha legenda do post).
        const earlyReferral = (item.referral || message?.referral) as {
          ref?: string
          ad_id?: string
          source?: string
          type?: string
          ads_context_data?: { ad_id?: string }
        } | undefined
        const earlyIsAd = Boolean(
          earlyReferral && (
            earlyReferral.source === 'ADS' ||
            earlyReferral.ad_id ||
            earlyReferral.ads_context_data?.ad_id
          )
        )

        const attachmentTypes = (message?.attachments || []).map((a) => a.type || 'unknown')
        const hasAttachments = attachmentTypes.length > 0
        const hasAudioAttachment = attachmentTypes.includes('audio')
        const hasOnlyIgnoredShare = hasAttachments && !hasAudioAttachment && !earlyIsAd
        // ‼️ Checagem de origem por anúncio (Instagram Ad / Click to Direct)
        const referral = (item.referral || message?.referral) as {
          ref?: string
          ad_id?: string
          source?: string
          type?: string
          ads_context_data?: {
            ad_id?: string
            ad_title?: string
            photo_url?: string
            video_url?: string
            post_id?: string
          }
          campaign_id?: string
          adset_id?: string
          adset_name?: string
        } | undefined

        const isAd = Boolean(
          referral && (
            referral.source === 'ADS' ||
            referral.ad_id ||
            referral.ads_context_data?.ad_id
          )
        )
        const metaAdId = referral?.ad_id || referral?.ads_context_data?.ad_id || null
        const adName = referral?.ads_context_data?.ad_title || null
        const metaCampaignId = referral?.campaign_id || null
        const metaAdsetId = referral?.adset_id || null
        const adsetName = referral?.adset_name || null

        const trackingSource = isAd ? 'instagram_ad' : 'instagram_direct'

        const inboundText = (message?.text || '').trim() || (hasAudioAttachment ? 'Recebi um áudio no Instagram.' : '') || (isAd ? 'Vim do anúncio do Instagram e quero saber mais.' : '')

        let instagramItemLogId: number | null = null
        try {
          const [itemLog] = await db.insert(webhookReceived).values({
            companyId: company.id,
            slug,
            source: 'instagram',
            event: 'instagram_direct_item',
            processed: false,
            skipReason: null,
            rawBody: instagramDebugPayload({
              entry,
              item,
              pageId: (entry.id as string) || undefined,
              companyId: company.id,
              slug,
              senderId: sender?.id ?? null,
              recipientId: recipient?.id ?? null,
              mid: message?.mid ?? null,
              text: message?.text ?? null,
              isEcho: message?.is_echo,
              attachmentTypes,
              referral: referral ?? null,
              isAd,
              trackingSource,
              decision: 'received',
            }),
            headers: headersObj,
          }).returning({ id: webhookReceived.id })
          instagramItemLogId = itemLog?.id ?? null
        } catch (logErr) {
          console.error('[Instagram Webhook] Erro ao registrar item detalhado:', logErr)
        }

        async function markInstagramItemLog(update: { processed?: boolean; skipReason?: string | null; errorMessage?: string | null; leadId?: number | null; decision: string; reason?: string | null }) {
          if (!instagramItemLogId) return
          try {
            await db.update(webhookReceived).set({
              processed: update.processed ?? false,
              skipReason: update.skipReason ?? null,
              errorMessage: update.errorMessage ?? null,
              leadId: update.leadId ?? null,
              rawBody: instagramDebugPayload({
                entry,
                item,
                pageId: (entry.id as string) || undefined,
                companyId: company.id,
                slug,
                senderId: sender?.id ?? null,
                recipientId: recipient?.id ?? null,
                mid: message?.mid ?? null,
                text: message?.text ?? null,
                isEcho: message?.is_echo,
                attachmentTypes,
                referral: referral ?? null,
                isAd,
                trackingSource,
                leadId: update.leadId ?? null,
                decision: update.decision,
                reason: update.reason ?? update.skipReason ?? update.errorMessage ?? null,
              }),
            }).where(eq(webhookReceived.id, instagramItemLogId))
          } catch (logErr) {
            console.error('[Instagram Webhook] Erro ao atualizar item detalhado:', logErr)
          }
        }

        // ‼️ 23/09/2026: ECO da própria conta (mesma causa raiz da rota global).
        if (message?.is_echo || (sender?.id && ownAccountIds.includes(sender.id))) {
          await markInstagramItemLog({ processed: false, skipReason: 'eco da própria conta', decision: 'skip_echo', reason: 'message.is_echo ou sender igual à conta' })
          console.log(`[Instagram Webhook] eco da própria conta ignorado, sender=${sender?.id}`)
          continue
        }

        if (hasOnlyIgnoredShare) {
          const types = attachmentTypes.join(', ')
          await markInstagramItemLog({ processed: false, skipReason: `anexo/partilha ignorado para IA (types=${types})`, decision: 'skip_attachment_share' })
          console.log(`[Instagram Webhook] anexo/partilha ignorado para IA (types=${types}), slug=${slug}, mid=${message?.mid}`)
          continue
        }

        if (sender?.id && inboundText) {
          try {
            // Idempotência contra reentrega de webhook da Meta: reentrega é
            // comportamento real dela, não hipotético. Sem isso, o mesmo
            // evento reentregue grava duas linhas inbound iguais e dispara
            // DUAS respostas reais de IA pro mesmo cliente pra mesma mensagem.
            if (message?.mid && await isInboundMessageAlreadyProcessed(company.id, message.mid)) {
              await markInstagramItemLog({ processed: false, skipReason: 'mensagem já processada (reentrega da Meta)', decision: 'skip_duplicate' })
              console.log(`[Instagram Webhook] mensagem já processada (reentrega da Meta), slug=${slug} mid=${message?.mid}, pulando`)
              continue
            }

            const igPhone = `ig_${sender.id}`
            const fallbackInstagramName = `Instagram Direct (${sender.id.slice(-4)})`
            let leadName = fallbackInstagramName

            const [existingLead] = await db
              .select({ id: recoveryLeads.id, name: recoveryLeads.name })
              .from(recoveryLeads)
              .where(and(
                eq(recoveryLeads.companyId, company.id),
                eq(recoveryLeads.phone, igPhone),
                sql`${recoveryLeads.platform} in ('instagram', 'sac', 'hermes', 'import_planilha')`,
              ))
              .limit(1)

            if (!existingLead) {
              const profile = await fetchInstagramUserProfile({ igsid: sender.id, companyId: company.id })
              if (profile.ok && profile.username) {
                leadName = `@${profile.username}`
              } else if (profile.ok && profile.name?.trim()) {
                leadName = profile.name
              }
            }

            const nameUpdateForConflict: Partial<typeof recoveryLeads.$inferInsert> = {}
            if (existingLead?.name?.startsWith('Instagram Direct')) {
              const profile = await fetchInstagramUserProfile({ igsid: sender.id, companyId: company.id })
              if (profile.ok && profile.username) {
                nameUpdateForConflict.name = `@${profile.username}`
              } else if (profile.ok && profile.name?.trim()) {
                nameUpdateForConflict.name = profile.name
              }
            }

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
                companyId: company.id,
                platform: 'instagram',
                channel: 'instagram',
                eventType: 'instagram_direct',
                phone: igPhone,
                name: leadName,
                status: 'in_conversation',
                trackingSource,
                ...(metaAdId ? { metaAdId: String(metaAdId) } : {}),
                ...(adName ? { adName: String(adName) } : {}),
                ...(metaCampaignId ? { metaCampaignId: String(metaCampaignId) } : {}),
                ...(metaAdsetId ? { metaAdsetId: String(metaAdsetId) } : {}),
                ...(adsetName ? { adsetName: String(adsetName) } : {}),
              })
              .onConflictDoUpdate({
                target: [recoveryLeads.companyId, recoveryLeads.phone],
                // Precisa bater EXATAMENTE com o WHERE do índice
                // recovery_leads_chat_company_phone_unique (schema.ts) pro
                // Postgres inferir o arbiter do ON CONFLICT. Ampliado pra
                // incluir 'hermes' em 22/09/2026 junto com a migration 0010
                // (fix de concorrência no webhook de conversão do Hermes) —
                // mudou lá, muda aqui também.
                targetWhere: sql`${recoveryLeads.platform} in ('instagram', 'sac', 'hermes', 'import_planilha')`,
                // lastActionAt precisa entrar aqui: o COALESCE de ordenação
                // do Inbox (lastActionAt, updatedAt, createdAt) trava no
                // primeiro valor não nulo, então um lead que já tem
                // lastActionAt de qualquer origem anterior nunca subia na
                // lista quando chegava DM nova, mesmo com updatedAt fresco.
                set: {
                  updatedAt: new Date(),
                  lastActionAt: new Date(),
                  channel: 'instagram',
                  ...nameUpdateForConflict,
                  ...(isAd
                    ? {
                        trackingSource: 'instagram_ad',
                        ...(metaAdId ? { metaAdId: String(metaAdId) } : {}),
                        ...(adName ? { adName: String(adName) } : {}),
                        ...(metaCampaignId ? { metaCampaignId: String(metaCampaignId) } : {}),
                        ...(metaAdsetId ? { metaAdsetId: String(metaAdsetId) } : {}),
                        ...(adsetName ? { adsetName: String(adsetName) } : {}),
                      }
                    : {}),
                },
              })
              .returning()

            if (isAd && lead?.id) {
              await db.insert(leadTags).values({
                leadId: lead.id,
                tag: 'anuncio',
                scopeChannel: 'instagram',
                createdBy: 'system:instagram_ad',
              }).onConflictDoNothing()
            }

            try {
              await db.insert(whatsappMessages).values({
                companyId: company.id,
                leadId: lead?.id ?? null,
                phone: igPhone,
                channel: 'instagram',
                direction: 'inbound',
                content: inboundText,
                messageType: 'text',
                sentBy: 'user',
                externalId: message?.mid ?? null,
              })
            } catch (err) {
              // Segunda camada (índice único parcial): corrida entre duas
              // requisições concorrentes que passaram pelo SELECT acima ao
              // mesmo tempo. Já processado, não é erro fatal.
              if (isUniqueViolation(err)) {
                await markInstagramItemLog({ processed: false, leadId: lead?.id ?? null, skipReason: 'corrida no insert, mensagem já processada', decision: 'skip_duplicate_race' })
                console.log(`[Instagram Webhook] corrida no insert (unique violation), slug=${slug} mid=${message?.mid}, tratando como já processado`)
                continue
              }
              throw err
            }

            await markInstagramItemLog({ processed: true, leadId: lead?.id ?? null, decision: isAd ? 'processed_as_instagram_ad' : 'processed_as_instagram_direct' })

            // Mensagem real trocada: se for a primeira, marca a abordagem do lead
            await markLeadContacted(lead?.id)

            // Gate de seguidor do Comment-to-DM (24/09/2026): mesma causa raiz e
            // mesmo fix da rota global (route.ts um nível acima) — se este lead
            // está no meio do fluxo de 2 mensagens de uma automação com
            // requireFollowCheck, a resposta dele NUNCA cai no
            // generateAndSendAiReply normal (evitaria duas respostas conflitantes
            // pro mesmo lead na mesma mensagem).
            // FIX CRÍTICO de QA (24/09/2026, 2ª rodada): `!lead.botPaused`
            // também nesta condição — pendente + pausado não manda nada
            // automático (nem gate, nem IA), decisão fica com o humano.
            if (lead?.id && lead.pendingFollowCheckAutomationId && !lead.botPaused) {
              const leadId = lead.id
              const automationId = lead.pendingFollowCheckAutomationId
              const igsid = sender.id
              after(() =>
                handleFollowCheckReply({ companyId: company.id, leadId, igsid, automationId }).catch((err) =>
                  console.error(`[Follow Check] erro no after() do webhook Instagram (slug=${slug}):`, err),
                ),
              )
            } else if (lead?.id && !lead.botPaused) {
              // Resposta automática de IA (Fase 1): mesmo motor do endpoint global
              // e do WhatsApp (decidido dentro de generateAndSendAiReply pelo
              // lead.channel). Roda depois do 200 sair, nunca atrasa o webhook.
              // Respeita botPaused e o gate de aiSystemPrompt.
              const leadId = lead.id
              after(() =>
                generateAndSendAiReply(leadId).catch((err) =>
                  console.error(`[AI Reply] erro no after() do webhook Instagram (slug=${slug}):`, err),
                ),
              )
            }
          } catch (err) {
            await markInstagramItemLog({ processed: false, errorMessage: err instanceof Error ? err.message : String(err), decision: 'error_processing_item' })
            console.error("[Instagram Webhook] Erro ao gravar mensagem:", err)
          }
        } else {
          await markInstagramItemLog({ processed: false, skipReason: 'sem sender ou sem texto processável', decision: 'skip_no_sender_or_text' })
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
              companyId: company.id,
              commentId,
              commenterId,
              commenterUsername,
              mediaId,
              commentText,
            }).catch(err => console.error(`[Comment-to-DM Webhook ${slug} Error]:`, err))
          }
        }
      }
    }
  }

  return NextResponse.json({ success: true })
}
