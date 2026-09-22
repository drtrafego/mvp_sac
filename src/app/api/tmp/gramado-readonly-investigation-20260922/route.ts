export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import postgres from 'postgres'

function maskUrl(url: string | null): string | null {
  return url ? url.replace(/:[^:@]+@/, ':****@') : null
}

function agentsUrl(): { source: string | null; url: string | null } {
  const candidates: [string, string | undefined][] = [
    ['CRM_DATABASE_URL', process.env.CRM_DATABASE_URL],
    ['SUPABASE_DATABASE_URL', process.env.SUPABASE_DATABASE_URL],
    ['AGENTS_DATABASE_URL', process.env.AGENTS_DATABASE_URL],
  ]
  const found = candidates.find(([, value]) => !!value)
  return found ? { source: found[0], url: found[1]! } : { source: null, url: null }
}

function toTransactionPooler(url: string): string {
  return url.includes('pooler.supabase.com') && url.includes(':5432')
    ? url.replace(':5432', ':6543')
    : url
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) return NextResponse.json({ error: 'DATABASE_URL missing' }, { status: 500 })

  const apiKey = req.headers.get('x-api-key')?.trim() || ''
  if (!apiKey) return NextResponse.json({ error: 'missing x-api-key' }, { status: 401 })

  const sql = neon(databaseUrl)

  const authRows = await sql`
    select c.id, c.slug, c.name
    from companies c
    left join settings s on s.company_id = c.id
    where c.slug = 'gramado-plaza'
      and (
        s.agent_bia_api_key = ${apiKey}
        or s.agent_luana_api_key = ${apiKey}
        or s.agent_renato_api_key = ${apiKey}
        or c.invite_token = ${apiKey}
      )
    limit 1
  `
  const company = authRows[0] as { id: number; slug: string; name: string } | undefined
  if (!company) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const from = new Date('2020-01-01T00:00:00-03:00')
  const to = new Date('2026-09-22T23:59:59.999-03:00')
  const todayFrom = new Date('2026-09-22T00:00:00-03:00')
  const deployAt = new Date('2026-09-22T14:43:00Z')

  const [
    dashboardRows,
    totalRows,
    pipelineRows,
    statusRows,
    eventRows,
    platformRows,
    sourceRows,
    conversionWebhookRows,
    conversionWebhookByHourRows,
    metaEventRows,
    metaEventByStatusRows,
    recentWebhookRows,
  ] = await Promise.all([
    sql`
      select
        count(*) filter (where created_at between ${from} and ${to})::int as period_total,
        count(*) filter (where created_at between ${from} and ${to} and first_contact_at is not null)::int as dashboard_total,
        count(*) filter (
          where created_at between ${from} and ${to}
            and first_contact_at is not null
            and coalesce(pipeline_stage, 'novo_contato') in ('novo_contato', 'novo', 'lead_captado', 'primeiro_contato')
        )::int as novo_contato,
        count(*) filter (
          where created_at between ${from} and ${to}
            and first_contact_at is not null
            and pipeline_stage in ('qualificado', 'duvida', 'avaliacao', 'data_consultada')
        )::int as qualificado,
        count(*) filter (
          where created_at between ${from} and ${to}
            and first_contact_at is not null
            and pipeline_stage in ('agendado', 'reuniao_agendada', 'horario_oferecido', 'consulta_agendada')
        )::int as agendado,
        count(*) filter (
          where created_at between ${from} and ${to}
            and first_contact_at is not null
            and pipeline_stage in ('proposta', 'proposta_enviada', 'negociacao', 'cardapio')
        )::int as proposta,
        count(*) filter (
          where created_at between ${from} and ${to}
            and first_contact_at is not null
            and (
              pipeline_stage in ('fechado', 'contrato_fechado', 'reserva_confirmada', 'compareceu', 'procedimento_realizado')
              or status in ('converted', 'completed', 'approved')
              or event_type in ('compra_aprovada', 'reserva_confirmada')
            )
        )::int as fechado_card,
        count(*) filter (
          where created_at between ${from} and ${to}
            and first_contact_at is not null
            and (
              status in ('converted', 'completed')
              or event_type in ('compra_aprovada', 'reserva_confirmada', 'agendado')
              or pipeline_stage in ('fechado', 'agendado')
            )
        )::int as fechados_total,
        count(*) filter (where pipeline_stage = 'agendado')::int as agendado_all,
        count(*) filter (where pipeline_stage = 'agendado' and created_at between ${todayFrom} and ${to})::int as agendado_created_today,
        count(*) filter (where pipeline_stage = 'agendado' and updated_at between ${deployAt} and ${to})::int as agendado_updated_after_deploy,
        count(*) filter (where event_type = 'reserva_confirmada')::int as event_reserva_confirmada_all,
        count(*) filter (where status = 'completed')::int as status_completed_all,
        count(*) filter (where platform = 'hermes')::int as platform_hermes_all,
        count(*) filter (where created_at between ${todayFrom} and ${to})::int as created_today,
        count(*) filter (where updated_at between ${deployAt} and ${to})::int as updated_after_deploy,
        min(created_at) as min_created_at,
        max(created_at) as max_created_at
      from recovery_leads
      where company_id = ${company.id}
    `,
    sql`
      select
        count(*)::int as recovery_leads,
        (select count(*)::int from whatsapp_messages where company_id = ${company.id}) as whatsapp_messages
      from recovery_leads
      where company_id = ${company.id}
    `,
    sql`
      select coalesce(pipeline_stage, '(null)') as key, count(*)::int as count
      from recovery_leads
      where company_id = ${company.id}
      group by 1
      order by count desc, key asc
    `,
    sql`
      select coalesce(status, '(null)') as key, count(*)::int as count
      from recovery_leads
      where company_id = ${company.id}
      group by 1
      order by count desc, key asc
    `,
    sql`
      select coalesce(event_type, '(null)') as key, count(*)::int as count
      from recovery_leads
      where company_id = ${company.id}
      group by 1
      order by count desc, key asc
    `,
    sql`
      select coalesce(platform, '(null)') as key, count(*)::int as count
      from recovery_leads
      where company_id = ${company.id}
      group by 1
      order by count desc, key asc
    `,
    sql`
      select coalesce(tracking_source, '(null)') as key, count(*)::int as count
      from recovery_leads
      where company_id = ${company.id}
      group by 1
      order by count desc, key asc
    `,
    sql`
      select
        count(*)::int as total,
        count(*) filter (where processed)::int as processed,
        count(*) filter (where not processed)::int as not_processed,
        min(received_at) as min_received_at,
        max(received_at) as max_received_at
      from webhook_received
      where company_id = ${company.id}
        and (source = 'hermes' or event = 'reserva_confirmada')
    `,
    sql`
      select
        date_trunc('hour', received_at) as hour,
        source,
        event,
        processed,
        coalesce(skip_reason, '(null)') as skip_reason,
        count(*)::int as count
      from webhook_received
      where company_id = ${company.id}
        and (source = 'hermes' or event = 'reserva_confirmada')
      group by 1,2,3,4,5
      order by hour desc
      limit 48
    `,
    sql`
      select
        count(*)::int as total,
        min(created_at) as min_created_at,
        max(created_at) as max_created_at,
        min(sent_at) as min_sent_at,
        max(sent_at) as max_sent_at
      from meta_conversion_events
      where company_id = ${company.id}
        and event_name = 'Schedule'
    `,
    sql`
      select status, count(*)::int as count
      from meta_conversion_events
      where company_id = ${company.id}
        and event_name = 'Schedule'
      group by status
      order by count desc, status asc
    `,
    sql`
      select received_at, source, event, processed, skip_reason, error_message is not null as has_error, lead_id
      from webhook_received
      where company_id = ${company.id}
        and (source = 'hermes' or event = 'reserva_confirmada')
      order by received_at desc
      limit 20
    `,
  ])

  const agentConfig = agentsUrl()
  const agentsReport: Record<string, unknown> = {
    configured: !!agentConfig.url,
    source: agentConfig.source,
    maskedUrl: maskUrl(agentConfig.url),
  }

  if (agentConfig.url) {
    const agentsSql = postgres(toTransactionPooler(agentConfig.url), {
      ssl: 'require',
      max: 1,
      idle_timeout: 5,
      connect_timeout: 30,
      prepare: false,
    })

    try {
      const gramadoAgents = await agentsSql`
        select a.id::text, a.slug, a.name, a.schema_name, a.active, o.slug as org_slug, o.name as org_name
        from public.agents a
        left join public.organizations o on o.id = a.organization_id
        where a.active = true
          and (
            lower(coalesce(a.slug,'')) like '%gramado%'
            or lower(coalesce(a.slug,'')) like '%plaza%'
            or lower(coalesce(a.name,'')) like '%gramado%'
            or lower(coalesce(a.name,'')) like '%plaza%'
            or lower(coalesce(o.slug,'')) like '%gramado%'
            or lower(coalesce(o.slug,'')) like '%plaza%'
            or lower(coalesce(o.name,'')) like '%gramado%'
            or lower(coalesce(o.name,'')) like '%plaza%'
          )
        order by o.slug, a.slug
      `

      const schemaReports = []
      for (const schema of Array.from(new Set(gramadoAgents.map((a) => a.schema_name).filter(Boolean)))) {
        const ident = agentsSql(String(schema))
        const [conversations] = await agentsSql`
          select count(*)::int as total,
                 min(started_at) as min_started_at,
                 max(started_at) as max_started_at,
                 min(coalesce(ended_at, started_at)) as min_sort_at,
                 max(coalesce(ended_at, started_at)) as max_sort_at
          from ${ident}.conversations
        `
        const [conversationsTop300] = await agentsSql`
          select count(*)::int as total,
                 min(sort_at) as oldest_in_top300,
                 max(sort_at) as newest_in_top300
          from (
            select coalesce(ended_at, started_at) as sort_at
            from ${ident}.conversations
            order by coalesce(ended_at, started_at) desc
            limit 300
          ) t
        `
        const [messages] = await agentsSql`
          select count(*)::int as total, min(ts) as min_ts, max(ts) as max_ts
          from ${ident}.messages
        `
        const tables = await agentsSql`
          select table_name
          from information_schema.tables
          where table_schema = ${String(schema)}
            and table_name in ('conversations','messages','crm_leads','agendamentos')
          order by table_name
        `
        const tableNames = new Set(tables.map((t) => t.table_name))
        const [crmLeads] = tableNames.has('crm_leads')
          ? await agentsSql`select count(*)::int as total from ${ident}.crm_leads`
          : [{ total: null }]
        const [agendamentos] = tableNames.has('agendamentos')
          ? await agentsSql`select count(*)::int as total from ${ident}.agendamentos`
          : [{ total: null }]

        schemaReports.push({
          schema,
          tables: Array.from(tableNames),
          conversations,
          conversationsTop300,
          messages,
          crmLeads,
          agendamentos,
        })
      }

      const [outreachGramado] = await agentsSql`
        select count(*)::int as total,
               min(last_at) as min_last_at,
               max(last_at) as max_last_at
        from public.outreach_convos
        where lower(coalesce(agent_slug,'')) like '%gramado%'
           or lower(coalesce(agent_slug,'')) like '%plaza%'
      `
      const [outreachGramadoTop300] = await agentsSql`
        with top as (
          select *
          from public.outreach_convos
          where agent_slug not ilike '%lucas%'
          order by last_at desc
          limit 300
        )
        select count(*)::int as gramado_in_top300_non_lucas,
               min(last_at) as min_last_at,
               max(last_at) as max_last_at
        from top
        where lower(coalesce(agent_slug,'')) like '%gramado%'
           or lower(coalesce(agent_slug,'')) like '%plaza%'
      `
      const [outreachNonLucas] = await agentsSql`
        select count(*)::int as total
        from public.outreach_convos
        where agent_slug not ilike '%lucas%'
      `
      const [publicLeads] = await agentsSql`
        select count(*)::int as total, min(created_at) as min_created_at, max(created_at) as max_created_at
        from public.leads
      `

      Object.assign(agentsReport, {
        gramadoAgents,
        schemaReports,
        outreachGramado,
        outreachGramadoTop300,
        outreachNonLucas,
        publicLeads,
      })
    } catch (error) {
      agentsReport.error = error instanceof Error ? error.message : String(error)
    } finally {
      await agentsSql.end({ timeout: 5 })
    }
  }

  return NextResponse.json({
    ok: true,
    commitPurpose: 'temporary-readonly-investigation-remove-after-use',
    company,
    period: { from: from.toISOString(), to: to.toISOString(), todayFrom: todayFrom.toISOString(), deployAt: deployAt.toISOString() },
    sac: {
      dashboard: dashboardRows[0],
      totals: totalRows[0],
      byPipelineStage: pipelineRows,
      byStatus: statusRows,
      byEventType: eventRows,
      byPlatform: platformRows,
      byTrackingSource: sourceRows,
      hermesWebhookSummary: conversionWebhookRows[0],
      hermesWebhookByHour: conversionWebhookByHourRows,
      recentHermesWebhooks: recentWebhookRows,
      metaScheduleSummary: metaEventRows[0],
      metaScheduleByStatus: metaEventByStatusRows,
    },
    agents: agentsReport,
  })
}
