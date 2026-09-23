export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import postgres from 'postgres'

const TOKEN = 'sac-investigation-20260923-a81f6d39-readonly'
const TARGET_COMPANIES = [
  { id: 4, expectedSlug: 'gramado-plaza', label: 'Gramado' },
  { id: 292, expectedSlug: 'autonomia', label: 'AutonomIA' },
] as const
const EXPECTED_SCHEMAS = ['gramado_plaza', 'autonomia'] as const
const TABLES = ['conversations', 'agendamentos', 'crm_leads', 'reservas'] as const

type Row = Record<string, any>

function toTransactionPooler(url: string): string {
  if (url.includes('pooler.supabase.com') && url.includes(':5432')) {
    return url.replace(':5432', ':6543')
  }
  return url
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`
}

function digits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '')
}

function phoneLast9(value: unknown): string {
  const d = digits(value)
  return d.length >= 9 ? d.slice(-9) : d
}

function maskPhone(value: unknown): string | null {
  const d = digits(value)
  if (!d) return null
  return `${'*'.repeat(Math.max(0, d.length - 4))}${d.slice(-4)}`
}

function maskEmail(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw || !raw.includes('@')) return null
  const [user, domain] = raw.split('@')
  return `${user.slice(0, 1)}***@${domain}`
}

function maskName(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const parts = raw.split(/\s+/)
  if (parts.length === 1) return `${parts[0].slice(0, 2)}***`
  return `${parts[0].slice(0, 2)}*** ${parts[parts.length - 1].slice(0, 1)}.`
}

function normalizeText(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')
}

function classifyLocalName(name: unknown, titles: unknown[]): string {
  const raw = String(name ?? '').trim()
  if (!raw) return 'empty'
  if (/^(atendimento|lead|contato)\s+\d+$/i.test(raw)) return 'fallback_placeholder'
  const normalized = normalizeText(raw)
  if (titles.some((title) => normalizeText(title) === normalized)) return 'matches_conversation_title'
  if (/\b(or[cç]amento|pedido|informac|reserva|consulta|procedimento|card[aá]pio|pre[cç]o|valor|d[uú]vida|agendamento)\b/i.test(raw)) {
    return 'looks_like_subject'
  }
  return 'not_obviously_generic'
}

function mapAgentToCompanySlug(agent: Row): string {
  const rawSlug = String(agent.slug || agent.org_slug || agent.name || '').toLowerCase()
  const rawName = String(agent.name || agent.org_name || '').toLowerCase()

  if (
    rawSlug.includes('autonomia') ||
    rawSlug.includes('gastao') ||
    rawSlug.includes('24horas') ||
    rawSlug.includes('casal') ||
    rawSlug.includes('trafego') ||
    rawName.includes('gast') ||
    rawName.includes('casal') ||
    rawName.includes('autonomia')
  ) {
    return 'autonomia'
  }
  if (rawSlug.includes('gramado') || rawSlug.includes('plaza')) return 'gramado-plaza'
  if (rawSlug.includes('lucas') || rawName.includes('lucas')) return 'drlucas'
  return rawSlug || rawName || 'unknown'
}

function pickColumn(columns: Set<string>, candidates: readonly string[]): string | null {
  return candidates.find((column) => columns.has(column)) ?? null
}

async function safeAgentsQuery<T extends Row = Row>(
  sql: ReturnType<typeof postgres>,
  query: string,
  params: any[] = []
): Promise<{ ok: true; rows: T[] } | { ok: false; error: string; rows: [] }> {
  try {
    const rows = await sql.unsafe<T[]>(query, params)
    return { ok: true, rows }
  } catch (error) {
    return { ok: false, error: String(error), rows: [] }
  }
}

function currentMonthBrt(): { from: string; to: string; fromDate: Date; toDate: Date } {
  const brtNow = new Date(Date.now() - 3 * 60 * 60 * 1000)
  const y = brtNow.getUTCFullYear()
  const m = brtNow.getUTCMonth()
  const fromDate = new Date(Date.UTC(y, m, 1, 3, 0, 0, 0))
  const toDate = new Date(Date.UTC(y, m + 1, 1, 2, 59, 59, 999))
  const pad = (n: number) => String(n).padStart(2, '0')
  const from = `${y}-${pad(m + 1)}-01`
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  const to = `${y}-${pad(m + 1)}-${pad(last)}`
  return { from, to, fromDate, toDate }
}

function sanitizeLead(row: Row) {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    phoneMasked: maskPhone(row.phone),
    emailMasked: maskEmail(row.email),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActionAt: row.last_action_at,
    trackingSource: row.tracking_source,
    platform: row.platform,
    eventType: row.event_type,
    channel: row.channel,
    firstContactAt: row.first_contact_at,
  }
}

async function describeTable(
  sql: ReturnType<typeof postgres>,
  schema: string,
  table: string,
  columns: Set<string>
) {
  if (columns.size === 0) {
    return {
      exists: false,
      columns: [],
      count: null,
      selectedNameColumn: null,
      selectedContactColumn: null,
      nameSamples: [],
    }
  }

  const countRes = await safeAgentsQuery(sql, `select count(*)::int as count from ${quoteIdent(schema)}.${quoteIdent(table)}`)
  const nameCol = pickColumn(columns, ['nome', 'name', 'lead_name', 'full_name', 'cliente', 'nome_cliente', 'paciente', 'hospede', 'customer_name', 'guest_name'])
  const contactCol = pickColumn(columns, ['telefone_norm', 'telefone', 'phone', 'whatsapp', 'celular', 'phone_norm', 'lead_handle', 'contact'])
  const dateCol = pickColumn(columns, ['updated_at', 'created_at', 'data_reserva', 'data', 'start_at', 'started_at'])
  let nameSamples: Row[] = []
  let sampleError: string | null = null

  if (nameCol) {
    const contactExpr = contactCol ? `${quoteIdent(contactCol)}::text` : 'null::text'
    const dateExpr = dateCol ? `${quoteIdent(dateCol)}::text` : 'null::text'
    const orderExpr = dateCol ? `${quoteIdent(dateCol)} desc nulls last` : `${quoteIdent(nameCol)} asc`
    const sampleRes = await safeAgentsQuery(
      sql,
      `
        select ${quoteIdent(nameCol)}::text as person_name,
               ${contactExpr} as contact,
               ${dateExpr} as observed_at
        from ${quoteIdent(schema)}.${quoteIdent(table)}
        where ${quoteIdent(nameCol)} is not null and trim(${quoteIdent(nameCol)}::text) <> ''
        order by ${orderExpr}
        limit 20
      `
    )
    if (sampleRes.ok) {
      nameSamples = sampleRes.rows.map((row) => ({
        personNameMasked: maskName(row.person_name),
        contactMasked: maskPhone(row.contact) ?? maskEmail(row.contact),
        observedAt: row.observed_at,
      }))
    } else {
      sampleError = sampleRes.error
    }
  }

  return {
    exists: true,
    columns: Array.from(columns),
    count: countRes.ok ? countRes.rows[0]?.count ?? null : null,
    countError: countRes.ok ? null : countRes.error,
    selectedNameColumn: nameCol,
    selectedContactColumn: contactCol,
    selectedDateColumn: dateCol,
    sampleError,
    nameSamples,
  }
}

async function prCompatibility(sql: ReturnType<typeof postgres>, schema: string, tableColumns: Record<string, Set<string>>) {
  const result: Row = {}

  if (tableColumns.agendamentos?.size) {
    const res = await safeAgentsQuery(
      sql,
      `
        select nome::text as name, telefone::text as telefone, telefone_norm::text as telefone_norm
        from ${quoteIdent(schema)}.agendamentos
        where nome is not null and trim(nome::text) <> ''
        limit 20
      `
    )
    result.agendamentosExactQuery = res.ok
      ? { ok: true, rows: res.rows.map((row) => ({ nameMasked: maskName(row.name), contactMasked: maskPhone(row.telefone_norm || row.telefone) })) }
      : { ok: false, error: res.error }
  } else {
    result.agendamentosExactQuery = { ok: false, error: 'table_absent' }
  }

  if (tableColumns.crm_leads?.size) {
    const res = await safeAgentsQuery(
      sql,
      `
        select name::text as name, phone::text as phone
        from ${quoteIdent(schema)}.crm_leads
        where name is not null and trim(name::text) <> ''
        limit 20
      `
    )
    result.crmLeadsExactQuery = res.ok
      ? { ok: true, rows: res.rows.map((row) => ({ nameMasked: maskName(row.name), contactMasked: maskPhone(row.phone) ?? maskEmail(row.phone) })) }
      : { ok: false, error: res.error }
  } else {
    result.crmLeadsExactQuery = { ok: false, error: 'table_absent' }
  }

  return result
}

async function findAgentMatchesForLead(
  sql: ReturnType<typeof postgres>,
  schema: string,
  tableColumns: Record<string, Set<string>>,
  last9: string
) {
  const matches: Row = {
    schema,
    conversations: [],
    agendamentos: [],
    crmLeads: [],
    reservas: [],
  }
  if (!last9) return matches

  if (tableColumns.conversations?.size) {
    const res = await safeAgentsQuery(
      sql,
      `
        select title::text as title, started_at::text as started_at, ended_at::text as ended_at
        from ${quoteIdent(schema)}.conversations
        where right(regexp_replace(coalesce(chat_id::text, session_id::text), '\\D', '', 'g'), 9) = $1
        order by coalesce(ended_at, started_at) desc nulls last
        limit 3
      `,
      [last9]
    )
    matches.conversations = res.ok ? res.rows : { error: res.error }
  }

  if (tableColumns.agendamentos?.has('nome') && (tableColumns.agendamentos.has('telefone') || tableColumns.agendamentos.has('telefone_norm'))) {
    const contactExpr = tableColumns.agendamentos.has('telefone_norm') && tableColumns.agendamentos.has('telefone')
      ? 'coalesce(telefone_norm::text, telefone::text)'
      : tableColumns.agendamentos.has('telefone_norm')
      ? 'telefone_norm::text'
      : 'telefone::text'
    const res = await safeAgentsQuery(
      sql,
      `
        select nome::text as name
        from ${quoteIdent(schema)}.agendamentos
        where right(regexp_replace(${contactExpr}, '\\D', '', 'g'), 9) = $1
          and nome is not null and trim(nome::text) <> ''
        limit 5
      `,
      [last9]
    )
    matches.agendamentos = res.ok ? res.rows.map((row) => ({ nameMasked: maskName(row.name) })) : { error: res.error }
  }

  if (tableColumns.crm_leads?.has('name') && tableColumns.crm_leads.has('phone')) {
    const res = await safeAgentsQuery(
      sql,
      `
        select name::text as name
        from ${quoteIdent(schema)}.crm_leads
        where right(regexp_replace(phone::text, '\\D', '', 'g'), 9) = $1
          and name is not null and trim(name::text) <> ''
        limit 5
      `,
      [last9]
    )
    matches.crmLeads = res.ok ? res.rows.map((row) => ({ nameMasked: maskName(row.name) })) : { error: res.error }
  }

  const reservasCols = tableColumns.reservas
  if (reservasCols?.size) {
    const nameCol = pickColumn(reservasCols, ['nome', 'name', 'cliente', 'nome_cliente', 'hospede', 'customer_name', 'guest_name'])
    const contactCol = pickColumn(reservasCols, ['telefone_norm', 'telefone', 'phone', 'whatsapp', 'celular', 'phone_norm', 'contact'])
    if (nameCol && contactCol) {
      const res = await safeAgentsQuery(
        sql,
        `
          select ${quoteIdent(nameCol)}::text as name
          from ${quoteIdent(schema)}.reservas
          where right(regexp_replace(${quoteIdent(contactCol)}::text, '\\D', '', 'g'), 9) = $1
            and ${quoteIdent(nameCol)} is not null and trim(${quoteIdent(nameCol)}::text) <> ''
          limit 5
        `,
        [last9]
      )
      matches.reservas = res.ok ? res.rows.map((row) => ({ nameMasked: maskName(row.name) })) : { error: res.error }
    }
  }

  return matches
}

async function sourceCount(localSql: any, companyId: number, source: string) {
  const isDirect = ['direto', 'direto / organico', 'direto / orgânico', 'organico', 'orgânico'].includes(source.trim().toLowerCase())
  const countRows = isDirect
    ? await localSql`
        select count(*)::int as count
        from recovery_leads
        where company_id = ${companyId}
          and coalesce(nullif(tracking_source, ''), nullif(platform, '')) is null
      `
    : await localSql`
        select count(*)::int as count
        from recovery_leads
        where company_id = ${companyId}
          and (tracking_source ilike ${`%${source}%`} or platform ilike ${`%${source}%`})
      `
  const sampleRows = isDirect
    ? await localSql`
        select id, name, phone, tracking_source, platform, event_type, channel, created_at::text, last_action_at::text
        from recovery_leads
        where company_id = ${companyId}
          and coalesce(nullif(tracking_source, ''), nullif(platform, '')) is null
        order by coalesce(last_action_at, updated_at, created_at) desc
        limit 5
      `
    : await localSql`
        select id, name, phone, tracking_source, platform, event_type, channel, created_at::text, last_action_at::text
        from recovery_leads
        where company_id = ${companyId}
          and (tracking_source ilike ${`%${source}%`} or platform ilike ${`%${source}%`})
        order by coalesce(last_action_at, updated_at, created_at) desc
        limit 5
      `
  const exactRows = await localSql`
    select count(*)::int as count
    from recovery_leads
    where company_id = ${companyId}
      and coalesce(nullif(tracking_source, ''), nullif(platform, ''), 'Direto / Orgânico') = ${source}
  `
  return {
    source,
    inboxIlikeCount: Number((countRows as Row[])[0]?.count ?? 0),
    dashboardExactCoalesceCount: Number((exactRows as Row[])[0]?.count ?? 0),
    sample: (sampleRows as Row[]).map(sanitizeLead),
  }
}

export async function GET(req: NextRequest) {
  const token = req.headers.get('x-probe-key') || req.nextUrl.searchParams.get('token')
  if (token !== TOKEN) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 })
  }

  const databaseUrl = process.env.DATABASE_URL
  const agentsCandidate: [string, string | undefined][] = [
    ['CRM_DATABASE_URL', process.env.CRM_DATABASE_URL],
    ['SUPABASE_DATABASE_URL', process.env.SUPABASE_DATABASE_URL],
    ['AGENTS_DATABASE_URL', process.env.AGENTS_DATABASE_URL],
  ]
  const agentsSource = agentsCandidate.find(([, value]) => Boolean(value))

  if (!databaseUrl || !agentsSource?.[1]) {
    return NextResponse.json(
      {
        ok: false,
        error: 'missing_database_env',
        hasDatabaseUrl: Boolean(databaseUrl),
        agentsEnvChecked: agentsCandidate.map(([name]) => name),
      },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } }
    )
  }

  const localSql = neon(databaseUrl)
  const agentsSql = postgres(toTransactionPooler(agentsSource[1]), {
    ssl: 'require',
    max: 1,
    idle_timeout: 5,
    connect_timeout: 20,
    prepare: false,
  })

  try {
    const period = currentMonthBrt()
    const [companies, localSamples, dashboardRows, agents] = await Promise.all([
      localSql`
        select id, name, slug
        from companies
        where id in (4, 292)
        order by id
      `,
      localSql`
        with ranked as (
          select
            id,
            company_id,
            name,
            phone,
            email,
            created_at::text as created_at,
            updated_at::text as updated_at,
            last_action_at::text as last_action_at,
            tracking_source,
            platform,
            event_type,
            channel,
            product_name,
            first_contact_at::text as first_contact_at,
            regexp_replace(coalesce(phone, ''), '\\D', '', 'g') as phone_digits,
            row_number() over (
              partition by company_id
              order by coalesce(last_action_at, updated_at, created_at) desc
            ) as rn
          from recovery_leads
          where company_id in (4, 292)
        )
        select *
        from ranked
        where rn <= 10
        order by company_id, rn
      `,
      localSql`
        select
          company_id,
          coalesce(nullif(tracking_source, ''), nullif(platform, ''), 'Direto / Orgânico') as source,
          count(*)::int as count
        from recovery_leads
        where company_id in (4, 292)
          and created_at >= ${period.fromDate}
          and created_at <= ${period.toDate}
          and first_contact_at is not null
        group by company_id, coalesce(nullif(tracking_source, ''), nullif(platform, ''), 'Direto / Orgânico')
        order by company_id, count(*) desc
      `,
      agentsSql.unsafe<Row[]>(`
        select a.id::text, a.slug, a.schema_name, a.name, o.slug as org_slug, o.name as org_name
        from public.agents a
        left join public.organizations o on o.id = a.organization_id
        where a.active = true
        order by o.slug, a.slug
      `),
    ])

    const agentsWithCompany: Row[] = (agents as Row[]).map((agent): Row => ({
      ...agent,
      mappedCompanySlug: mapAgentToCompanySlug(agent),
    }))
    const targetSchemas = Array.from(new Set([
      ...EXPECTED_SCHEMAS,
      ...agentsWithCompany
        .filter((agent) => agent.mappedCompanySlug === 'gramado-plaza' || agent.mappedCompanySlug === 'autonomia')
        .map((agent) => String(agent.schema_name || '').trim())
        .filter(Boolean),
    ]))

    const columnRows = targetSchemas.length
      ? await agentsSql.unsafe<Row[]>(
          `
            select table_schema, table_name, column_name
            from information_schema.columns
            where table_schema = any($1)
              and table_name = any($2)
            order by table_schema, table_name, ordinal_position
          `,
          [targetSchemas, TABLES as unknown as string[]]
        )
      : []

    const columnsBySchemaTable: Record<string, Record<string, Set<string>>> = {}
    for (const schema of targetSchemas) {
      columnsBySchemaTable[schema] = {}
      for (const table of TABLES) columnsBySchemaTable[schema][table] = new Set<string>()
    }
    for (const row of columnRows) {
      columnsBySchemaTable[row.table_schema] ||= {}
      columnsBySchemaTable[row.table_schema][row.table_name] ||= new Set<string>()
      columnsBySchemaTable[row.table_schema][row.table_name].add(String(row.column_name))
    }

    const schemaDiagnostics: Row[] = []
    for (const schema of targetSchemas) {
      const tableColumns = columnsBySchemaTable[schema] || {}
      const tables: Row = {}
      for (const table of TABLES) {
        tables[table] = await describeTable(agentsSql, schema, table, tableColumns[table] || new Set<string>())
      }
      schemaDiagnostics.push({
        schema,
        mappedAgents: agentsWithCompany
          .filter((agent) => agent.schema_name === schema)
          .map((agent) => ({
            slug: agent.slug,
            name: agent.name,
            orgSlug: agent.org_slug,
            mappedCompanySlug: agent.mappedCompanySlug,
          })),
        tables,
        prCompatibility: await prCompatibility(agentsSql, schema, tableColumns),
      })
    }

    const schemaByCompany: Record<number, string[]> = {
      4: targetSchemas.filter((schema) => {
        if (schema === 'gramado_plaza') return true
        return agentsWithCompany.some((agent) => agent.schema_name === schema && agent.mappedCompanySlug === 'gramado-plaza')
      }),
      292: targetSchemas.filter((schema) => {
        if (schema === 'autonomia') return true
        return agentsWithCompany.some((agent) => agent.schema_name === schema && agent.mappedCompanySlug === 'autonomia')
      }),
    }

    const sampleDiagnostics: Row[] = []
    for (const sample of localSamples as Row[]) {
      const last9 = phoneLast9(sample.phone_digits || sample.phone)
      const schemas = schemaByCompany[Number(sample.company_id)] || []
      const agentMatches = []
      for (const schema of schemas) {
        agentMatches.push(await findAgentMatchesForLead(agentsSql, schema, columnsBySchemaTable[schema] || {}, last9))
      }
      const titles = agentMatches.flatMap((match) => Array.isArray(match.conversations) ? match.conversations.map((c: Row) => c.title) : [])
      sampleDiagnostics.push({
        ...sanitizeLead(sample),
        localNameAssessment: classifyLocalName(sample.name, titles),
        matchedConversationTitles: titles.slice(0, 3),
        agentMatches,
      })
    }

    const dashboardByCompany: Row[] = []
    for (const target of TARGET_COMPANIES) {
      const rows = (dashboardRows as Row[]).filter((row) => Number(row.company_id) === target.id)
      const sourcesToTest = Array.from(new Set([
        ...rows.slice(0, 5).map((row) => String(row.source)),
        'agente_ia',
      ].filter(Boolean)))
      const sourceTests = []
      for (const source of sourcesToTest) {
        sourceTests.push(await sourceCount(localSql, target.id, source))
      }
      dashboardByCompany.push({
        companyId: target.id,
        label: target.label,
        period: { from: period.from, to: period.to },
        dashboardTrafficBreakdown: rows.map((row) => ({ source: row.source, count: row.count })),
        sourceTests,
      })
    }

    const response = NextResponse.json({
      ok: true,
      probe: 'sac-investigation-20260923-a81f6d39',
      generatedAt: new Date().toISOString(),
      localCompanies: companies,
      agentsDbSource: agentsSource[0],
      agents: agentsWithCompany.map((agent) => ({
        slug: agent.slug,
        name: agent.name,
        orgSlug: agent.org_slug,
        schemaName: agent.schema_name,
        mappedCompanySlug: agent.mappedCompanySlug,
      })),
      schemaDiagnostics,
      samples: sampleDiagnostics,
      sourceFiltering: dashboardByCompany,
    })
    response.headers.set('Cache-Control', 'no-store, max-age=0')
    return response
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: String(error) },
      { status: 500, headers: { 'Cache-Control': 'no-store, max-age=0' } }
    )
  } finally {
    await agentsSql.end({ timeout: 1 }).catch(() => undefined)
  }
}
