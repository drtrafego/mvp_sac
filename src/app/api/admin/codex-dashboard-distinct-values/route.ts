export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { classifyChannelInMemory } from '@/lib/inbox-channel-filter'
import { normalizeOrigin } from '@/lib/origins'

const TOKEN = 'codex-ad-leads-20260922-autonomia-292'

type LeadRow = {
  id: number
  name: string | null
  phone_masked: string | null
  phone_class_signal: string | null
  has_phone: boolean
  has_email: boolean
  expected_channel: string
  created_at: string
  channel: string | null
  platform: string | null
  tracking_source: string | null
  event_type: string | null
  utm_campaign: string | null
  utm_source: string | null
  utm_medium: string | null
  mining_tags: unknown
  ad_signal: boolean
  mining_signal: boolean
}

function channelLabel(classification: ReturnType<typeof classifyChannelInMemory>): string {
  if (classification.isMineracao) return 'mineracao'
  if (classification.isEmail) return 'email'
  if (classification.isInstagram) return 'instagram'
  return 'whatsapp'
}

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const sql = neon(process.env.DATABASE_URL!)
  const rows = await sql`
    with lead_base as (
      select
        id,
        name,
        phone,
        email,
        created_at,
        channel,
        platform,
        tracking_source,
        event_type,
        utm_campaign,
        tracking_source as utm_source,
        utm_medium,
        mining_tags,
        regexp_replace(coalesce(phone, ''), '\\D', '', 'g') as phone_digits,
        lower(concat_ws(' ', tracking_source, event_type, utm_campaign, utm_medium, platform, raw_payload::text)) as combined
      from recovery_leads
      where company_id = 292
    )
    select
      id,
      name,
      case
        when length(phone_digits) >= 4 then '***' || right(phone_digits, 4)
        else null
      end as phone_masked,
      case when left(lower(coalesce(phone, '')), 3) = 'ig_' then 'ig_' else null end as phone_class_signal,
      length(phone_digits) >= 8 as has_phone,
      coalesce(email, '') <> '' as has_email,
      case when length(phone_digits) >= 8 then 'whatsapp' else 'email' end as expected_channel,
      created_at::text,
      channel,
      platform,
      tracking_source,
      event_type,
      utm_campaign,
      utm_source,
      utm_medium,
      mining_tags,
      (
        coalesce(tracking_source, '') ~* '(^|[^a-z])(meta|facebook|fb|ads|anuncio|campanha|campaign)'
        or coalesce(event_type, '') ~* '(^|[^a-z])(meta|facebook|fb|ads|anuncio|campanha|campaign)'
        or coalesce(utm_campaign, '') <> ''
        or combined ~* '(^|[^a-z])(meta|facebook|fb|ads|anuncio|campanha|campaign)'
      ) as ad_signal,
      (
        coalesce(channel, '') ~* '(^|[^a-z])(miner|mining|prospeccao|places)'
        or coalesce(platform, '') ~* '(^|[^a-z])(miner|mining|prospeccao|places)'
        or coalesce(tracking_source, '') ~* '(^|[^a-z])(miner|mining|prospeccao|places)'
        or coalesce(event_type, '') ~* '(^|[^a-z])(miner|mining|prospeccao|places)'
        or combined ~* '(^|[^a-z])(miner|mining|prospeccao|places)'
      ) as mining_signal
    from lead_base
    order by created_at desc
    limit 25
  `

  const leads = (rows as unknown as LeadRow[]).map((row) => {
    const channelClassification = classifyChannelInMemory({
      channel: row.channel,
      platform: row.platform,
      trackingSource: row.tracking_source,
      phone: row.phone_class_signal,
    })
    const origin = normalizeOrigin(row.tracking_source, row.utm_medium, row.platform, row.event_type, row.channel)

    return {
      id: row.id,
      name: row.name,
      phoneMasked: row.phone_masked,
      createdAt: row.created_at,
      channel: row.channel,
      expectedChannel: row.expected_channel,
      channelMatchesExpected: row.channel === row.expected_channel,
      classifyChannelInMemory: channelLabel(channelClassification),
      normalizeOrigin: {
        key: origin.key,
        label: origin.label,
        category: origin.category,
        subcategory: origin.subcategory ?? null,
      },
      trackingSource: row.tracking_source,
      eventType: row.event_type,
      utmCampaign: row.utm_campaign,
      utmSource: row.utm_source,
      utmMedium: row.utm_medium,
      miningTags: row.mining_tags ?? null,
      adSignal: row.ad_signal,
      miningSignal: row.mining_signal,
    }
  })

  const adCandidates = leads.filter((lead) => lead.adSignal && !lead.miningSignal).slice(0, 3)

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    companyId: 292,
    count: adCandidates.length,
    leads: adCandidates,
    recentLeads: leads,
  })
}
