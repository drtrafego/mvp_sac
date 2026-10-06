export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { channelWhereCondition } from '@/lib/inbox-channel-filter'
import { isDirectOrganicSourceFilter, normalizeInboxSourceFilter } from '@/lib/inbox-source-filter'
function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  response.headers.set('Surrogate-Control', 'no-store')
  return response
}


// Contagem real por canal (COUNT com FILTER, não em memória sobre um LIMIT).
// A lista principal (/api/inbox) corta em 200 registros por aba de canal;
// esta rota conta a empresa inteira, então os números da aba batem com o
// banco mesmo quando o canal tem mais de 200 conversas.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const { searchParams } = new URL(req.url)
  const sourceFilter = normalizeInboxSourceFilter(searchParams.get('source'))

  const instagramCond = channelWhereCondition('instagram')!
  const emailCond = channelWhereCondition('email')!
  const mineracaoCond = channelWhereCondition('mineracao')!
  const anuncioCond = channelWhereCondition('anuncio')!
  const whatsappCond = channelWhereCondition('whatsapp')!
  // Subcategorias: canal REAL de contato dentro do universo já classificado
  // como mineracao (mesma condição principal, segunda dimensão de filtro).
  // A soma das 3 sempre bate com `mineracao` acima, pela mesma garantia de
  // precedência/cobertura total do channelWhereCondition.
  const mineracaoEmailCond = channelWhereCondition('mineracao_email')!
  const mineracaoWhatsappCond = channelWhereCondition('mineracao_whatsapp')!
  const mineracaoInstagramCond = channelWhereCondition('mineracao_instagram')!
  const anuncioMetaAdsCond = channelWhereCondition('anuncio_meta_ads')!
  const anuncioGoogleAdsCond = channelWhereCondition('anuncio_google_ads')!
  const sourceCondition = sourceFilter
    ? isDirectOrganicSourceFilter(sourceFilter)
      ? sql<boolean>`coalesce(nullif(${recoveryLeads.trackingSource}, ''), nullif(${recoveryLeads.platform}, '')) is null`
      : sql<boolean>`(${recoveryLeads.trackingSource} ILIKE ${'%' + sourceFilter + '%'} OR ${recoveryLeads.platform} ILIKE ${'%' + sourceFilter + '%'})`
    : undefined
  const whereConditions = [eq(recoveryLeads.companyId, company.id)]
  if (sourceCondition) whereConditions.push(sourceCondition)

  const [row] = await db
    .select({
      all: sql<number>`count(*)`,
      whatsapp: sql<number>`count(*) filter (where ${whatsappCond})`,
      instagram: sql<number>`count(*) filter (where ${instagramCond})`,
      email: sql<number>`count(*) filter (where ${emailCond})`,
      mineracao: sql<number>`count(*) filter (where ${mineracaoCond})`,
      anuncio: sql<number>`count(*) filter (where ${anuncioCond})`,
      mineracaoEmail: sql<number>`count(*) filter (where ${mineracaoEmailCond})`,
      mineracaoWhatsapp: sql<number>`count(*) filter (where ${mineracaoWhatsappCond})`,
      mineracaoInstagram: sql<number>`count(*) filter (where ${mineracaoInstagramCond})`,
      anuncioMetaAds: sql<number>`count(*) filter (where ${anuncioMetaAdsCond})`,
      anuncioGoogleAds: sql<number>`count(*) filter (where ${anuncioGoogleAdsCond})`,
    })
    .from(recoveryLeads)
    .where(and(...whereConditions))

  return noStoreJson({
    all: Number(row?.all ?? 0),
    whatsapp: Number(row?.whatsapp ?? 0),
    instagram: Number(row?.instagram ?? 0),
    email: Number(row?.email ?? 0),
    mineracao: Number(row?.mineracao ?? 0),
    anuncio: Number(row?.anuncio ?? 0),
    mineracaoEmail: Number(row?.mineracaoEmail ?? 0),
    mineracaoWhatsapp: Number(row?.mineracaoWhatsapp ?? 0),
    mineracaoInstagram: Number(row?.mineracaoInstagram ?? 0),
    anuncioMetaAds: Number(row?.anuncioMetaAds ?? 0),
    anuncioGoogleAds: Number(row?.anuncioGoogleAds ?? 0),
  })
}
