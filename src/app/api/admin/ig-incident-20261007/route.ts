export const dynamic = 'force-dynamic'
export const maxDuration = 180

import { NextRequest, NextResponse } from 'next/server'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { companies, recoveryLeads, whatsappMessages, leadTags } from '@/lib/db/schema'
import { generateAndSendAiReply } from '@/lib/ai-reply'

const KEY = 'ig_20261007_v8H2mQx7rP'

function authorized(req: NextRequest): boolean {
  return new URL(req.url).searchParams.get('key') === KEY
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const rows = await db
    .select({
      leadId: recoveryLeads.id,
      companyId: companies.id,
      companyName: companies.name,
      companySlug: companies.slug,
      phone: recoveryLeads.phone,
      name: recoveryLeads.name,
      channel: recoveryLeads.channel,
      platform: recoveryLeads.platform,
      trackingSource: recoveryLeads.trackingSource,
      botPaused: recoveryLeads.botPaused,
      createdAt: recoveryLeads.createdAt,
      updatedAt: recoveryLeads.updatedAt,
      lastActionAt: recoveryLeads.lastActionAt,
      inboundCount: sql<number>`cast(count(${whatsappMessages.id}) filter (where ${whatsappMessages.direction} = 'inbound') as int)`,
      outboundCount: sql<number>`cast(count(${whatsappMessages.id}) filter (where ${whatsappMessages.direction} = 'outbound') as int)`,
      lastInboundAt: sql<Date | null>`max(${whatsappMessages.createdAt}) filter (where ${whatsappMessages.direction} = 'inbound')`,
      lastOutboundAt: sql<Date | null>`max(${whatsappMessages.createdAt}) filter (where ${whatsappMessages.direction} = 'outbound')`,
      lastInboundText: sql<string | null>`(array_agg(${whatsappMessages.content} order by ${whatsappMessages.createdAt} desc) filter (where ${whatsappMessages.direction} = 'inbound'))[1]`,
      lastOutboundText: sql<string | null>`(array_agg(${whatsappMessages.content} order by ${whatsappMessages.createdAt} desc) filter (where ${whatsappMessages.direction} = 'outbound'))[1]`,
      tags: sql<string[]>`coalesce(array_agg(distinct ${leadTags.tag}) filter (where ${leadTags.tag} is not null), '{}')`,
    })
    .from(recoveryLeads)
    .innerJoin(companies, eq(companies.id, recoveryLeads.companyId))
    .leftJoin(whatsappMessages, and(eq(whatsappMessages.companyId, recoveryLeads.companyId), eq(whatsappMessages.leadId, recoveryLeads.id)))
    .leftJoin(leadTags, eq(leadTags.leadId, recoveryLeads.id))
    .where(and(
      sql`(${recoveryLeads.channel} = 'instagram' or ${recoveryLeads.platform} ilike '%instagram%' or ${recoveryLeads.phone} like 'ig_%')`,
      sql`${recoveryLeads.createdAt} >= now() - interval '36 hours'`,
    ))
    .groupBy(recoveryLeads.id, companies.id)
    .orderBy(desc(sql`coalesce(max(${whatsappMessages.createdAt}), ${recoveryLeads.updatedAt}, ${recoveryLeads.createdAt})`))
    .limit(30)

  const unattended = rows.filter((row) => Number(row.inboundCount || 0) > 0 && Number(row.outboundCount || 0) === 0)
  return NextResponse.json({ marker: 'ig-incident-20261007', count: rows.length, unattendedCount: unattended.length, unattended, rows })
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { leadId?: number }
  const leadId = Number(body.leadId)
  if (!Number.isInteger(leadId) || leadId <= 0) return NextResponse.json({ error: 'leadId inválido' }, { status: 400 })

  await generateAndSendAiReply(leadId)
  return NextResponse.json({ ok: true, leadId })
}
