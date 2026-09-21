export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recoveryLeads, settings } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq, and } from 'drizzle-orm'
import { fetchAdAttribution } from '@/lib/ads-attribution'

type Params = { params: Promise<{ idOrSlug: string; leadId: string }> }

/**
 * Atribuição de anúncio de UM lead: qual campanha/conjunto/anúncio trouxe
 * esse contato, resolvida via Graph API (Marketing API) a partir do
 * meta_ad_id salvo no lead. Porta de utm_do_anuncio()/origem_da_conversa()
 * do painel antigo (agente_painel/app.py), adaptada ao dado que o SAC
 * guarda hoje.
 *
 * Prioridade igual à do painel antigo: UTM que já veio salvo com o lead no
 * momento do evento (webhook do checkout/formulário) vale mais que consultar
 * a Graph API de novo, porque é o estado no clique, não o de hoje. A Graph
 * API só é chamada quando falta UTM e existe um meta_ad_id numérico.
 */
export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug, leadId } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const id = parseInt(leadId)
  if (isNaN(id)) return NextResponse.json({ error: 'ID inválido' }, { status: 400 })

  const [lead] = await db
    .select({
      id: recoveryLeads.id,
      trackingSource: recoveryLeads.trackingSource,
      utmMedium: recoveryLeads.utmMedium,
      utmCampaign: recoveryLeads.utmCampaign,
      utmContent: recoveryLeads.utmContent,
      utmTerm: recoveryLeads.utmTerm,
      utmPlacement: recoveryLeads.utmPlacement,
      metaCampaignId: recoveryLeads.metaCampaignId,
      metaAdsetId: recoveryLeads.metaAdsetId,
      metaAdId: recoveryLeads.metaAdId,
    })
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, context.company.id)))

  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 })

  const utmSalvo: Record<string, string> = {}
  if (lead.trackingSource) utmSalvo.utm_source = lead.trackingSource
  if (lead.utmMedium) utmSalvo.utm_medium = lead.utmMedium
  if (lead.utmCampaign) utmSalvo.utm_campaign = lead.utmCampaign
  if (lead.utmContent) utmSalvo.utm_content = lead.utmContent
  if (lead.utmTerm) utmSalvo.utm_term = lead.utmTerm
  if (lead.utmPlacement) utmSalvo.utm_placement = lead.utmPlacement
  const temUtmSalvo = Object.keys(utmSalvo).length > 0

  const meta = {
    campaignId: lead.metaCampaignId || null,
    adsetId: lead.metaAdsetId || null,
    adId: lead.metaAdId || null,
  }

  // Sem UTM salvo e sem ad_id: não tem o que atribuir (lead orgânico, ou a
  // origem não chegou a capturar rastreamento nenhum).
  if (!temUtmSalvo && !meta.adId) {
    return NextResponse.json({
      ok: true,
      leadId: id,
      atribuido: false,
      origem: null,
      utm: {},
      meta,
      anuncio: null,
      erro: null,
    })
  }

  // UTM já salvo com o lead: essa é a atribuição, sem precisar da Graph API.
  if (temUtmSalvo) {
    return NextResponse.json({
      ok: true,
      leadId: id,
      atribuido: true,
      origem: 'lead', // veio junto do evento (checkout/formulário)
      utm: utmSalvo,
      meta,
      anuncio: null,
      erro: null,
    })
  }

  // Só tem ad_id: consulta a Marketing API da conta de anúncios da empresa.
  const [row] = await db
    .select({ metaAdsAccessToken: settings.metaAdsAccessToken, metaAdsAccountId: settings.metaAdsAccountId })
    .from(settings)
    .where(eq(settings.companyId, context.company.id))

  const resultado = await fetchAdAttribution(row?.metaAdsAccessToken, meta.adId, row?.metaAdsAccountId)

  if (!resultado.ok) {
    return NextResponse.json({
      ok: true,
      leadId: id,
      atribuido: false,
      origem: null,
      utm: {},
      meta,
      anuncio: null,
      erro: resultado.error,
    })
  }

  return NextResponse.json({
    ok: true,
    leadId: id,
    atribuido: Object.keys(resultado.utm).length > 0 || Boolean(resultado.campaignName),
    origem: 'campanha', // resolvido agora via Graph API, a partir do ad_id
    utm: resultado.utm,
    meta,
    anuncio: {
      adId: resultado.adId,
      adName: resultado.adName,
      adsetId: resultado.adsetId,
      adsetName: resultado.adsetName,
      campaignId: resultado.campaignId,
      campaignName: resultado.campaignName,
      urlTags: resultado.urlTags,
      urlTagsResolvido: resultado.urlTagsResolved,
      dinamico: resultado.dinamico,
    },
    erro: null,
  })
}
