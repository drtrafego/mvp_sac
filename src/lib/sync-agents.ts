import { db } from '@/lib/db'
import { companies, settings, syncCursors, recoveryLeads, whatsappMessages } from '@/lib/db/schema'
import { queryAgentsDb, getAgentsDbUrl } from '@/lib/db/agents-db'
import { eq, and, sql } from 'drizzle-orm'
import { backfillFirstContactFromMessages } from '@/lib/leads'

// ─── Decisão de arquitetura: cursores reais por fonte ───────────────────────
// Este sync roda em produção a cada 10 minutos. Antes, os blocos de fonte
// externa usavam "ORDER BY ... DESC LIMIT 300" sem cursor; com mais de 300
// linhas, cada cron relia a mesma janela recente e o histórico antigo nunca
// entrava (caso real: public.outreach_convos tinha 4380 linhas, só 300
// visíveis para sempre).
//
// A correção usa a tabela local sync_cursors, com uma linha por empresa +
// fonte + chave da fonte (ex.: agent_conversations/drlucas,
// outreach_convos/autonomia, crm_leads/public). Cada linha guarda:
// - newest_synced_at/id: fronteira do sweep de novidades; busca linhas mais
//   novas que a última já processada, com lote alto para o uso normal do cron.
// - backfill_before_at/id: fronteira do backfill; a cada execução anda até
//   300 registros para trás, até esgotar o histórico.
//
// O par timestamp + id é deliberado: só timestamp pode perder/duplicar páginas
// quando muitas linhas compartilham a mesma data. A escrita local continua
// idempotente pelos mapas de lead/telefone/e-mail e externalId das mensagens;
// o cursor só avança depois que o lote da fonte foi processado.

export interface AgentDbRow {
  id: string
  organization_id: string
  org_slug?: string
  org_name?: string
  slug: string
  schema_name: string
  name: string
  meta_phone_number_id?: string | null
  meta_waba_id?: string | null
  meta_token_env?: string | null
}

export interface ConversationDbRow {
  session_id: string
  chat_id: string | null
  channel?: string | null
  title: string | null
  started_at?: string | null
  ended_at?: string | null
  message_count?: number | null
  __sync_sort_at?: string | Date | null
  __sync_cursor_id?: string | number | null
}

export interface MessageDbRow {
  id: string | number
  session_id: string
  role: string
  content: string | null
  ts?: string | null
  platform_message_id?: string | null
}

export interface OutreachConvoDbRow {
  id: string
  agent_slug: string
  channel: string | null
  source: string | null
  lead_name: string | null
  lead_handle: string | null
  lead_company: string | null
  status: string | null
  last_at: string | null
  msg_count?: number | null
  // Tags de mineração (21/09/2026): colunas OPCIONAIS no Agents DB, gravadas
  // pelo lado do minerador (outreach_sync.py, trabalho da Luana, em paralelo
  // e pode não estar pronto ainda). Só aparecem aqui quando
  // detectOutreachTagColumns() confirmou a existência da coluna ANTES do
  // SELECT incluí-la — se não existir, o campo simplesmente vem undefined,
  // sem quebrar a query nem o sync. Nomes reais conforme
  // central-db/outreach_sync.py:91-97 (ALTER TABLE do lado da Luana): nicho,
  // origem, temperatura, outreach_status. "origem" aqui é a coluna NOVA
  // (origem real do lead), diferente de "source" abaixo, que é uma constante
  // fixa "prospeccao" sempre presente e não tem relação com a origem real.
  nicho?: string | null
  origem?: string | null
  temperatura?: string | null
  outreach_status?: string | null
  __sync_sort_at?: string | Date | null
  __sync_cursor_id?: string | number | null
}

export interface OutreachMsgDbRow {
  id: string
  convo_id: string
  direction: string | null
  status: string | null
  subject: string | null
  body: string | null
  sent_at: string | null
}

export interface CtwaReferralDbRow {
  id?: string | null
  phone_norm: string
  campaign_name: string | null
  ad_name: string | null
  created_at?: string | null
  ts?: string | number | null
  synced_at?: string | null
  __sync_sort_at?: string | Date | null
  __sync_cursor_id?: string | number | null
}

export interface MetaLeadDbRow {
  phone_norm: string
  full_name: string | null
  email: string | null
  campaign_name: string | null
  ad_name: string | null
  platform?: string | null
}

export interface CrmLeadDbRow {
  id: string
  organization_id: string | null
  whatsapp: string | null
  email: string | null
  name: string | null
  company: string | null
  notes: string | null
  value: string | number | null
  status: string | null
  follow_up_date: string | null
  follow_up_note: string | null
  campaign_source: string | null
  utm_source: string | null
  utm_medium: string | null
  utm_campaign: string | null
  utm_content: string | null
  utm_term: string | null
  ai_agent: string | null
  created_at: string | null
  first_contact_at: string | null
  __sync_sort_at?: string | Date | null
  __sync_cursor_id?: string | number | null
}

export interface SyncReport {
  ok: boolean
  message: string
  agentsFound: number
  companiesCreated: number
  leadsCreated: number
  messagesImported: number
  details: string[]
  dbUrlUsed?: string | null
}

function normalizeDigits(val: string | null | undefined): string {
  if (!val) return ''
  return val.replace(/\D/g, '')
}

// ─── Resolução do nome real do lead (22/09/2026) ───────────────────────────
// Bug reportado: o bloco 3 (sync de conversas de agente IA) gravava
// name: cv.title (o ASSUNTO/resumo gerado da conversa, ex.: "Custo da
// eletrocauterização"), nunca o nome de verdade da pessoa, e nunca atualizava
// depois da criação. Investigação confirmou duas fontes melhores no mesmo
// Agents DB, mesmo schema por empresa: "<schema>".agendamentos.nome (nome
// dito na hora de marcar consulta, cobertura menor mas o mais confiável) e
// "<schema>".crm_leads.name (nome capturado pelo CRM/kanban nativo do
// Hermes, cobertura maior mas ocasionalmente ruim, ex. "Resposta De Cleide").
//
// Prioridade: agendamentos.nome > crm_leads.name válido (descartando
// placeholder "Lead 123") > conversations.title (fallback atual) >
// "Atendimento XXXX" (fallback final).
//
// Nem toda empresa tem agendamentos/crm_leads no Agents DB (Gramado,
// AutonomIA não têm necessariamente esse formato) — checagem de existência
// de tabela ANTES de consultar, mesmo padrão de detectOutreachTagColumns()
// abaixo, pra nunca derrubar o bloco 3 inteiro por uma tabela ausente.
const LEAD_PLACEHOLDER_NAME_RE = /^Lead\s+\d+$/i
const FALLBACK_ATENDIMENTO_NAME_RE = /^Atendimento\s+\d+$/i

export type LeadNameSource = 'agendamento' | 'crm' | 'title' | 'fallback'

const LEAD_NAME_SOURCE_RANK: Record<LeadNameSource, number> = {
  fallback: 0,
  title: 1,
  crm: 2,
  agendamento: 3,
}

export function resolveLeadName(opts: {
  agendamentoName?: string | null
  crmName?: string | null
  title?: string | null
  fallback: string
}): { name: string; source: LeadNameSource } {
  const agendamentoName = (opts.agendamentoName || '').trim()
  if (agendamentoName) return { name: agendamentoName, source: 'agendamento' }

  const crmName = (opts.crmName || '').trim()
  if (crmName && !LEAD_PLACEHOLDER_NAME_RE.test(crmName)) return { name: crmName, source: 'crm' }

  const title = (opts.title || '').trim()
  if (title) return { name: title, source: 'title' }

  return { name: opts.fallback, source: 'fallback' }
}

// Como o "name" salvo hoje não guarda de qual fonte ele veio, infere a
// origem mais provável pelo FORMATO do valor já gravado, só pra decidir se
// vale a pena sobrescrever. Regra de segurança: nunca conhecemos a origem
// real com certeza, então tratamos qualquer nome que não bata em nenhum
// padrão de placeholder/título como "pelo menos tão bom quanto crm" (rank 2)
// — assim um nome de verdade já salvo nunca é rebaixado por um título ou
// fallback chegando depois, só é trocado por outro de rank igual ou maior
// (crm mais atualizado, ou agendamento, que é sempre a melhor fonte).
export function inferStoredLeadNameSource(
  storedName: string | null | undefined,
  title: string | null | undefined,
  fallback: string
): LeadNameSource {
  const stored = (storedName || '').trim()
  if (!stored) return 'fallback'
  if (stored === fallback) return 'fallback'
  if (FALLBACK_ATENDIMENTO_NAME_RE.test(stored)) return 'fallback'
  if (LEAD_PLACEHOLDER_NAME_RE.test(stored)) return 'fallback'
  if (title && stored === title.trim()) return 'title'
  return 'crm'
}

export function shouldUpdateLeadName(
  current: { name: string; source: LeadNameSource },
  next: { name: string; source: LeadNameSource }
): boolean {
  if (!next.name || current.name === next.name) return false
  return LEAD_NAME_SOURCE_RANK[next.source] >= LEAD_NAME_SOURCE_RANK[current.source]
}

async function tableExistsInAgentsDb(schema: string, table: string): Promise<boolean> {
  const rows = await queryAgentsDb<{ exists: boolean }>(
    `
      select exists (
        select 1 from information_schema.tables
        where table_schema = $1 and table_name = $2
      ) as exists
    `,
    [schema, table]
  )
  return !!rows?.[0]?.exists
}

interface AgendamentoDbRow {
  nome: string | null
  telefone: string | null
  telefone_norm: string | null
}

interface CrmLeadNameDbRow {
  name: string | null
  phone: string | null
}

// Mapa telefone (dígitos limpos, chave cheia + últimos 9) -> nome, pras duas
// fontes melhores do bloco 3. Só consulta quando a tabela existe no schema.
async function loadPhoneNameMap(
  schema: string,
  table: 'agendamentos' | 'crm_leads'
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const exists = await tableExistsInAgentsDb(schema, table)
  if (!exists) return map

  const rows =
    table === 'agendamentos'
      ? await queryAgentsDb<AgendamentoDbRow>(`
          select nome, telefone, telefone_norm
          from "${schema}".agendamentos
          where nome is not null and trim(nome) <> ''
        `)
      : await queryAgentsDb<CrmLeadNameDbRow>(`
          select name, phone
          from "${schema}".crm_leads
          where name is not null and trim(name) <> ''
        `)

  for (const r of rows || []) {
    const rawName = table === 'agendamentos' ? (r as AgendamentoDbRow).nome : (r as CrmLeadNameDbRow).name
    const name = (rawName || '').trim()
    if (!name) continue

    const rawPhone =
      table === 'agendamentos'
        ? (r as AgendamentoDbRow).telefone_norm || (r as AgendamentoDbRow).telefone
        : (r as CrmLeadNameDbRow).phone
    const norm = normalizeDigits(rawPhone)
    if (!norm) continue
    const last9 = norm.length >= 9 ? norm.slice(-9) : norm

    // Primeira ocorrência por telefone vence (não há orderBy garantido de
    // "mais recente" nas duas tabelas); suficiente para o propósito de achar
    // UM nome de verdade por telefone.
    if (!map.has(norm)) map.set(norm, name)
    if (!map.has(last9)) map.set(last9, name)
  }

  return map
}

// Tags de mineração (21/09/2026): nicho, origem, temperatura e status de
// relacionamento consolidado ainda não existem em public.outreach_convos no
// Agents DB (a Luana trabalha nisso em paralelo, outreach_sync.py, e pode não
// ter terminado). Selecionar uma coluna inexistente derruba a query INTEIRA
// (queryAgentsDb captura o erro e devolve null), o que quebraria todo o bloco
// 4 de sync de leads/mensagens de mineração, não só as tags. Por isso a lista
// de colunas do SELECT é montada dinamicamente: só entra o que o
// information_schema confirma existir agora. Roda de novo em toda chamada de
// sync, então o dia em que a coluna aparecer ela passa a ser lida sozinha,
// sem precisar de deploy novo aqui.
// Nomes REAIS confirmados em central-db/outreach_sync.py:91-97 (ALTER TABLE
// do lado da Luana): nicho, origem, temperatura, outreach_status.
const OUTREACH_TAG_COLUMN_CANDIDATES = ['nicho', 'origem', 'temperatura', 'outreach_status'] as const

async function detectAgentsTableColumns(
  schema: string,
  table: string,
  candidates: readonly string[]
): Promise<Set<string>> {
  const rows = await queryAgentsDb<{ column_name: string }>(
    `
      select column_name
      from information_schema.columns
      where table_schema = $1 and table_name = $2
        and column_name = ANY($3)
    `,
    [schema, table, candidates as unknown as string[]]
  )
  return new Set((rows || []).map((r) => r.column_name))
}

async function detectOutreachTagColumns(): Promise<Set<string>> {
  return detectAgentsTableColumns('public', 'outreach_convos', OUTREACH_TAG_COLUMN_CANDIDATES)
}

const SYNC_BACKFILL_BATCH_SIZE = 300
const SYNC_NEW_BATCH_SIZE = 5000
const EPOCH_CURSOR_ISO = '1970-01-01T00:00:00.000Z'

type SyncCursorSource = 'agent_conversations' | 'outreach_convos' | 'crm_leads' | 'ctwa_referrals'
type SyncCursorRow = typeof syncCursors.$inferSelect

interface CursorPosition {
  at: Date
  id: string
}

function parseCursorDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function buildCursorPosition(
  atValue: string | Date | null | undefined,
  idValue: string | number | null | undefined
): CursorPosition | null {
  const at = parseCursorDate(atValue)
  const id = idValue == null ? '' : String(idValue)
  if (!at || !id) return null
  return { at, id }
}

function compareCursorPositions(a: CursorPosition, b: CursorPosition): number {
  const timeDiff = a.at.getTime() - b.at.getTime()
  if (timeDiff !== 0) return timeDiff
  return a.id.localeCompare(b.id)
}

function pickNewestPosition<T>(rows: T[], getPosition: (row: T) => CursorPosition | null): CursorPosition | null {
  let newest: CursorPosition | null = null
  for (const row of rows) {
    const pos = getPosition(row)
    if (pos && (!newest || compareCursorPositions(pos, newest) > 0)) newest = pos
  }
  return newest
}

function pickOldestPosition<T>(rows: T[], getPosition: (row: T) => CursorPosition | null): CursorPosition | null {
  let oldest: CursorPosition | null = null
  for (const row of rows) {
    const pos = getPosition(row)
    if (pos && (!oldest || compareCursorPositions(pos, oldest) < 0)) oldest = pos
  }
  return oldest
}

function dedupeTimedRows<T>(rows: T[], getPosition: (row: T) => CursorPosition | null): T[] {
  const seen = new Set<string>()
  const deduped: T[] = []

  for (const row of rows) {
    const pos = getPosition(row)
    const key = pos ? `${pos.at.toISOString()}::${pos.id}` : null
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    deduped.push(row)
  }

  return deduped
}

function currentCursorPosition(at: Date | null, id: string | null): CursorPosition | null {
  return buildCursorPosition(at, id)
}

function cursorTimestampParam(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

async function getOrCreateSyncCursor(
  companyId: number,
  source: SyncCursorSource,
  sourceKey: string
): Promise<SyncCursorRow> {
  const where = and(
    eq(syncCursors.companyId, companyId),
    eq(syncCursors.source, source),
    eq(syncCursors.sourceKey, sourceKey)
  )

  let [cursor] = await db.select().from(syncCursors).where(where).limit(1)
  if (cursor) return cursor

  await db
    .insert(syncCursors)
    .values({ companyId, source, sourceKey })
    .onConflictDoNothing()

  ;[cursor] = await db.select().from(syncCursors).where(where).limit(1)
  if (!cursor) {
    throw new Error(`Não foi possível criar cursor de sync ${source}/${sourceKey} para company_id=${companyId}`)
  }
  return cursor
}

interface TimedSyncBatch<T> {
  rows: T[]
  newRows: T[]
  backfillRows: T[]
  markProcessed: () => Promise<void>
}

async function loadTimedSyncBatch<T>(opts: {
  companyId: number
  source: SyncCursorSource
  sourceKey: string
  getPosition: (row: T) => CursorPosition | null
  fetchNewRows: (cursor: SyncCursorRow) => Promise<T[] | null>
  fetchBackfillRows: (cursor: SyncCursorRow) => Promise<T[] | null>
}): Promise<TimedSyncBatch<T> | null> {
  const cursor = await getOrCreateSyncCursor(opts.companyId, opts.source, opts.sourceKey)
  let newRows: T[] = []

  if (cursor.newestSyncedAt) {
    const fetched = await opts.fetchNewRows(cursor)
    if (!fetched) return null
    newRows = fetched
  }

  const backfillRows = await opts.fetchBackfillRows(cursor)
  if (!backfillRows) return null

  return {
    rows: dedupeTimedRows([...newRows, ...backfillRows], opts.getPosition),
    newRows,
    backfillRows,
    markProcessed: () => markTimedSyncBatchProcessed(cursor, newRows, backfillRows, opts.getPosition),
  }
}

async function markTimedSyncBatchProcessed<T>(
  cursor: SyncCursorRow,
  newRows: T[],
  backfillRows: T[],
  getPosition: (row: T) => CursorPosition | null
): Promise<void> {
  const now = new Date()
  const updateData: Partial<typeof syncCursors.$inferInsert> = {
    lastRunAt: now,
    updatedAt: now,
  }

  const currentNewest = currentCursorPosition(cursor.newestSyncedAt, cursor.newestSyncedId)
  const newestFromNewRows = pickNewestPosition(newRows, getPosition)
  const newestFromBootstrap = cursor.newestSyncedAt ? null : pickNewestPosition(backfillRows, getPosition)
  const nextNewest = [newestFromNewRows, newestFromBootstrap]
    .filter((pos): pos is CursorPosition => !!pos)
    .reduce<CursorPosition | null>((best, pos) => (!best || compareCursorPositions(pos, best) > 0 ? pos : best), null)

  if (nextNewest && (!currentNewest || compareCursorPositions(nextNewest, currentNewest) > 0)) {
    updateData.newestSyncedAt = nextNewest.at
    updateData.newestSyncedId = nextNewest.id
  }

  const oldestFromBackfill = pickOldestPosition(backfillRows, getPosition)
  if (oldestFromBackfill) {
    updateData.backfillBeforeAt = oldestFromBackfill.at
    updateData.backfillBeforeId = oldestFromBackfill.id
  }

  await db.update(syncCursors).set(updateData).where(eq(syncCursors.id, cursor.id))
}

function conversationCursorPosition(row: ConversationDbRow): CursorPosition | null {
  return buildCursorPosition(
    row.__sync_sort_at ?? row.ended_at ?? row.started_at ?? EPOCH_CURSOR_ISO,
    row.__sync_cursor_id ?? row.session_id
  )
}

function outreachCursorPosition(row: OutreachConvoDbRow): CursorPosition | null {
  return buildCursorPosition(row.__sync_sort_at ?? row.last_at ?? EPOCH_CURSOR_ISO, row.__sync_cursor_id ?? row.id)
}

function crmLeadCursorPosition(row: CrmLeadDbRow): CursorPosition | null {
  return buildCursorPosition(
    row.__sync_sort_at ?? row.created_at ?? row.first_contact_at ?? EPOCH_CURSOR_ISO,
    row.__sync_cursor_id ?? row.id
  )
}

function ctwaTsToDate(value: string | number | null | undefined): Date | null {
  if (value == null || value === '') return null
  const epoch = Number(value)
  if (!Number.isFinite(epoch) || epoch <= 0) return null

  const millis = epoch > 9_999_999_999 ? epoch : epoch * 1000
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? null : date
}

function ctwaCursorPosition(row: CtwaReferralDbRow): CursorPosition | null {
  return buildCursorPosition(
    row.__sync_sort_at ?? ctwaTsToDate(row.ts) ?? row.synced_at ?? row.created_at ?? EPOCH_CURSOR_ISO,
    row.__sync_cursor_id ?? row.id ?? `${row.phone_norm}|${row.campaign_name || ''}|${row.ad_name || ''}`
  )
}

export async function syncAgentsAndCompanies(): Promise<SyncReport> {
  const details: string[] = []
  let companiesCreated = 0
  let leadsCreated = 0
  let messagesImported = 0

  const dbUrl = await getAgentsDbUrl()
  const dbUrlMasked = dbUrl ? dbUrl.replace(/:[^:@]+@/, ':****@') : 'Não configurado'

  // 1. Garante imediatamente as empresas principais no banco de dados local
  const defaultCompanies = [
    { name: 'AutonomIA', slug: 'autonomia' },
    { name: 'Gramado Plaza', slug: 'gramado-plaza' },
    { name: 'Dr. Lucas', slug: 'drlucas' },
  ]

  const companyMap = new Map<string, typeof companies.$inferSelect>()

  for (const def of defaultCompanies) {
    let [comp] = await db.select().from(companies).where(eq(companies.slug, def.slug)).limit(1)
    if (!comp) {
      const [created] = await db
        .insert(companies)
        .values({ name: def.name, slug: def.slug, plan: 'pro' })
        .returning()
      comp = created
      companiesCreated++
      details.push(`Empresa "${def.name}" (${def.slug}) criada.`)
    }
    companyMap.set(def.slug, comp)

    // Garante settings
    const [st] = await db.select().from(settings).where(eq(settings.companyId, comp.id)).limit(1)
    if (!st) {
      await db.insert(settings).values({ companyId: comp.id, whatsappProvider: 'meta' }).onConflictDoNothing()
    }
  }

  // 2. Busca agentes na tabela public.agents do Supabase / Neon de agentes
  const agents = await queryAgentsDb<AgentDbRow>(`
    select a.id, a.organization_id, o.slug as org_slug, o.name as org_name,
           a.slug, a.schema_name, a.name, a.meta_phone_number_id, a.meta_waba_id, a.meta_token_env
    from public.agents a
    left join public.organizations o on o.id = a.organization_id
    where a.active = true
    order by o.slug, a.slug
  `)

  if (!agents || agents.length === 0) {
    return {
      ok: false,
      message: `Nenhum agente ativo encontrado na base (${dbUrlMasked}). Verifique a string de conexão.`,
      agentsFound: 0,
      companiesCreated,
      leadsCreated,
      messagesImported,
      details: [
        ...details,
        `Tentativa de conexão com: ${dbUrlMasked}`,
      ],
      dbUrlUsed: dbUrlMasked,
    }
  }

  details.push(`Encontrados ${agents.length} agentes ativos no catálogo Supabase/Neon.`)

  // Pre-carrega em memória os telefones e externalIds existentes para evitar N+1 queries
  const existingLeadsRows = await db
    .select({ id: recoveryLeads.id, companyId: recoveryLeads.companyId, phone: recoveryLeads.phone, email: recoveryLeads.email, name: recoveryLeads.name })
    .from(recoveryLeads)

  const leadMap = new Map<string, number>()
  // Nome atualmente salvo por lead (id -> name), usado só pra decidir se vale
  // a pena sobrescrever com um nome melhor no bloco 3 (ver resolveLeadName /
  // shouldUpdateLeadName acima). Mantido em memória e atualizado localmente
  // a cada troca nesta mesma rodada, pra não precisar reler do banco.
  const leadNameMap = new Map<number, string | null>()
  for (const row of existingLeadsRows) {
    leadNameMap.set(row.id, row.name)
    if (row.phone) {
      const clean = row.phone.replace(/\D/g, '') || row.phone
      leadMap.set(`${row.companyId}_${clean}`, row.id)
      if (clean.length >= 9) leadMap.set(`${row.companyId}_${clean.slice(-9)}`, row.id)
    }
    if (row.email) {
      leadMap.set(`${row.companyId}_${row.email.trim().toLowerCase()}`, row.id)
    }
  }

  const existingMsgsRows = await db
    .select({ externalId: whatsappMessages.externalId })
    .from(whatsappMessages)
    .where(sql`${whatsappMessages.externalId} IS NOT NULL`)

  const existingMsgIds = new Set<string>(existingMsgsRows.map(m => m.externalId!).filter(Boolean))

  for (const agent of agents) {
    const rawSlug = (agent.slug || agent.org_slug || agent.name.toLowerCase().replace(/\s+/g, '-')).toLowerCase()
    const rawName = agent.name || agent.org_name || 'Agente IA'

    let companySlug = rawSlug
    let companyName = rawName

    if (rawSlug.includes('autonomia') || rawSlug.includes('gastao') || rawSlug.includes('24horas') || rawSlug.includes('casal') || rawSlug.includes('trafego') || rawName.toLowerCase().includes('gast') || rawName.toLowerCase().includes('casal') || rawName.toLowerCase().includes('autonomia')) {
      companySlug = 'autonomia'
      companyName = 'AutonomIA'
    } else if (rawSlug.includes('gramado') || rawSlug.includes('plaza')) {
      companySlug = 'gramado-plaza'
      companyName = 'Gramado Plaza'
    } else if (rawSlug.includes('lucas') || rawName.toLowerCase().includes('lucas')) {
      companySlug = 'drlucas'
      companyName = 'Dr. Lucas'
    }

    let company = companyMap.get(companySlug)
    if (!company) {
      let [existingComp] = await db.select().from(companies).where(eq(companies.slug, companySlug)).limit(1)
      if (!existingComp) {
        const [created] = await db
          .insert(companies)
          .values({ name: companyName, slug: companySlug, plan: 'pro' })
          .returning()
        existingComp = created
        companiesCreated++
      }
      company = existingComp
      companyMap.set(companySlug, company)
    }

    // Persiste o nome de persona do bot (ex.: "Clara" pro Dr. Lucas) pra UI
    // do Inbox parar de mostrar "Bot IA" genérico (22/09/2026). agent.name é
    // a fonte de verdade única (não existe tela de edição manual ainda), por
    // isso SEMPRE sincroniza, sem checar valor anterior: não há "edição do
    // usuário" pra proteger, e um nome desatualizado aqui é sempre pior que
    // o nome atual do Agents DB. Só grava quando muda, pra não gerar updates
    // (e updatedAt) à toa em toda rodada de sync.
    if (agent.name && agent.name.trim() && company.agentDisplayName !== agent.name.trim()) {
      const newAgentDisplayName = agent.name.trim()
      await db
        .update(companies)
        .set({ agentDisplayName: newAgentDisplayName, updatedAt: new Date() })
        .where(eq(companies.id, company.id))
      company.agentDisplayName = newAgentDisplayName
      companyMap.set(companySlug, company)
    }

    // 3. Sincroniza Conversas e Mensagens do schema do agente em BATCH
    const schema = agent.schema_name
    if (schema) {
      try {
        const conversationSortExpr = `coalesce(ended_at, started_at, '${EPOCH_CURSOR_ISO}'::timestamp)`
        const conversationIdExpr = 'session_id::text'
        const conversationBatch = await loadTimedSyncBatch<ConversationDbRow>({
          companyId: company.id,
          source: 'agent_conversations',
          sourceKey: schema,
          getPosition: conversationCursorPosition,
          fetchNewRows: (cursor) =>
            queryAgentsDb<ConversationDbRow>(
              `
                select session_id, chat_id, channel, title, started_at, ended_at, message_count,
                       ${conversationSortExpr} as __sync_sort_at,
                       ${conversationIdExpr} as __sync_cursor_id
                from "${schema}".conversations
                where (${conversationSortExpr}, ${conversationIdExpr}) > ($1::timestamp, $2::text)
                order by ${conversationSortExpr} asc, ${conversationIdExpr} asc
                limit ${SYNC_NEW_BATCH_SIZE}
              `,
              [cursorTimestampParam(cursor.newestSyncedAt), cursor.newestSyncedId || '']
            ),
          fetchBackfillRows: (cursor) => {
            const hasBackfillCursor = !!cursor.backfillBeforeAt
            return queryAgentsDb<ConversationDbRow>(
              `
                select session_id, chat_id, channel, title, started_at, ended_at, message_count,
                       ${conversationSortExpr} as __sync_sort_at,
                       ${conversationIdExpr} as __sync_cursor_id
                from "${schema}".conversations
                ${hasBackfillCursor ? `where (${conversationSortExpr}, ${conversationIdExpr}) < ($1::timestamp, $2::text)` : ''}
                order by ${conversationSortExpr} desc, ${conversationIdExpr} desc
                limit ${SYNC_BACKFILL_BATCH_SIZE}
              `,
              hasBackfillCursor ? [cursorTimestampParam(cursor.backfillBeforeAt), cursor.backfillBeforeId || ''] : []
            )
          },
        })
        const convs = conversationBatch?.rows || []

        // Fontes melhores de nome do lead que o título da conversa (ver
        // resolveLeadName acima). Toleram schema sem essas tabelas (Gramado,
        // AutonomIA): loadPhoneNameMap checa a existência antes de consultar
        // e devolve mapa vazio, sem derrubar o bloco.
        const agendamentoNameByPhone = await loadPhoneNameMap(schema, 'agendamentos')
        const crmNameByPhone = await loadPhoneNameMap(schema, 'crm_leads')

        if (convs && convs.length > 0) {
          const sessionIds = convs.map(c => c.session_id).filter(Boolean)

          const msgs = sessionIds.length > 0 ? await queryAgentsDb<MessageDbRow>(`
            select id, session_id, role, content, ts, platform_message_id
            from "${schema}".messages
            where session_id = ANY($1)
            order by ts asc
          `, [sessionIds]) : []

          const msgsBySession = new Map<string, MessageDbRow[]>()
          if (msgs) {
            for (const m of msgs) {
              if (!msgsBySession.has(m.session_id)) msgsBySession.set(m.session_id, [])
              msgsBySession.get(m.session_id)!.push(m)
            }
          }

          for (const cv of convs) {
            const rawPhone = cv.chat_id || cv.session_id
            if (!rawPhone) continue
            const cleanPhone = normalizeDigits(rawPhone) || rawPhone
            const last9 = cleanPhone.length >= 9 ? cleanPhone.slice(-9) : cleanPhone

            let leadId = leadMap.get(`${company.id}_${cleanPhone}`) || leadMap.get(`${company.id}_${last9}`)
            const isExistingLead = !!leadId
            const channelType = cv.channel?.includes('email')
              ? 'email'
              : cv.channel?.includes('insta')
              ? 'instagram'
              : 'whatsapp'

            let leadDate = cv.ended_at ? new Date(cv.ended_at) : (cv.started_at ? new Date(cv.started_at) : new Date())
            if (isNaN(leadDate.getTime())) leadDate = new Date()

            // Nome do lead: agendamentos.nome > crm_leads.name válido >
            // conversations.title > "Atendimento XXXX". Recalculado em TODA
            // rodada de sync com o que está disponível agora, pra um lead
            // criado só com título poder ganhar o nome real depois que a
            // pessoa marcar consulta ou aparecer no CRM.
            const fallbackName = `Atendimento ${cleanPhone.slice(-4)}`
            const resolvedName = resolveLeadName({
              agendamentoName: agendamentoNameByPhone.get(cleanPhone) || agendamentoNameByPhone.get(last9),
              crmName: crmNameByPhone.get(cleanPhone) || crmNameByPhone.get(last9),
              title: cv.title,
              fallback: fallbackName,
            })

            if (!leadId) {
              const [newLead] = await db
                .insert(recoveryLeads)
                .values({
                  companyId: company.id,
                  phone: cleanPhone,
                  name: resolvedName.name,
                  platform: 'sac',
                  channel: channelType,
                  eventType: 'atendimento_ia',
                  status: 'in_conversation',
                  trackingSource: companySlug === 'drlucas' ? 'whatsapp_sac' : 'agente_ia',
                  createdAt: cv.started_at ? new Date(cv.started_at) : new Date(),
                  updatedAt: leadDate,
                  lastActionAt: leadDate,
                })
                .returning()

              leadId = newLead.id
              leadMap.set(`${company.id}_${cleanPhone}`, leadId)
              if (cleanPhone.length >= 9) leadMap.set(`${company.id}_${last9}`, leadId)
              leadNameMap.set(leadId, newLead.name)
              leadsCreated++
            } else {
              // Lead já existe: só sobrescreve o nome se a fonte calculada
              // agora for de prioridade MAIOR OU IGUAL à que provavelmente
              // gerou o valor salvo (ver inferStoredLeadNameSource /
              // shouldUpdateLeadName acima). Isso permite promover
              // "Atendimento 1234" ou o título pra um nome real quando
              // agendamentos/crm_leads aparecerem depois, sem nunca
              // rebaixar um nome de verdade já salvo por um título ou
              // fallback.
              const storedName = leadNameMap.get(leadId) ?? null
              const currentSource = inferStoredLeadNameSource(storedName, cv.title, fallbackName)
              if (shouldUpdateLeadName({ name: storedName || '', source: currentSource }, resolvedName)) {
                await db
                  .update(recoveryLeads)
                  .set({ name: resolvedName.name })
                  .where(eq(recoveryLeads.id, leadId))
                leadNameMap.set(leadId, resolvedName.name)
              }
            }

            const convMsgs = msgsBySession.get(cv.session_id) || []
            const msgsToInsert: (typeof whatsappMessages.$inferInsert)[] = []

            for (const m of convMsgs) {
              const externalId = `agent_${schema}_${m.id || m.platform_message_id || cv.session_id + '_' + m.ts}`
              if (existingMsgIds.has(externalId)) continue

              const isUser = m.role === 'user'
              const msgDate = m.ts ? new Date(m.ts) : new Date()

              msgsToInsert.push({
                companyId: company.id,
                leadId: leadId,
                phone: cleanPhone,
                channel: channelType,
                direction: isUser ? 'inbound' : 'outbound',
                content: m.content || '',
                messageType: 'text',
                sentBy: isUser ? 'user' : 'bot',
                externalId,
                createdAt: msgDate,
              })
              existingMsgIds.add(externalId)
            }

            if (msgsToInsert.length > 0) {
              await db.insert(whatsappMessages).values(msgsToInsert)
              messagesImported += msgsToInsert.length

              // Lead já existia (senão lastActionAt já saiu certo lá em cima,
              // no insert): sem isto, o COALESCE de ordenação do Inbox
              // (lastActionAt, updatedAt, createdAt) trava no valor antigo pra
              // sempre, porque lastActionAt já preenchido nunca "libera" pro
              // updatedAt aparecer. Usa o timestamp REAL da mensagem mais
              // recente do lote (não now()), pra refletir quando a conversa
              // de fato aconteceu.
              if (isExistingLead) {
                const latestMsgDate = msgsToInsert.reduce(
                  (max, m) => ((m.createdAt as Date) > max ? (m.createdAt as Date) : max),
                  msgsToInsert[0].createdAt as Date
                )
                await db
                  .update(recoveryLeads)
                  .set({ lastActionAt: latestMsgDate, updatedAt: latestMsgDate })
                  .where(eq(recoveryLeads.id, leadId))
              }
            }
          }
        }
        await conversationBatch?.markProcessed()
      } catch (convErr) {
        details.push(`Aviso ao sincronizar conversas do schema "${schema}": ${String(convErr)}`)
      }
    }
  }

  // 4. Sincroniza Leads e Mensagens de Mineração / Prospecção em BATCH
  try {
    const outreachTagCols = await detectOutreachTagColumns()
    const outreachTagSelect = Array.from(outreachTagCols)
      .map((c) => `, ${c}`)
      .join('')

    const outreachSortExpr = `coalesce(last_at, '${EPOCH_CURSOR_ISO}'::timestamp)`
    const outreachIdExpr = 'id::text'
    const outreachScopes = [
      {
        sourceKey: 'autonomia',
        company: companyMap.get('autonomia'),
        whereSql: "agent_slug not ilike '%lucas%' and agent_slug not ilike '%gramado%' and agent_slug not ilike '%plaza%'",
      },
      {
        sourceKey: 'gramado-plaza',
        company: companyMap.get('gramado-plaza'),
        whereSql: "agent_slug not ilike '%lucas%' and (agent_slug ilike '%gramado%' or agent_slug ilike '%plaza%')",
      },
    ]

    for (const scope of outreachScopes) {
      if (!scope.company) continue

      const outreachBatch = await loadTimedSyncBatch<OutreachConvoDbRow>({
        companyId: scope.company.id,
        source: 'outreach_convos',
        sourceKey: scope.sourceKey,
        getPosition: outreachCursorPosition,
        fetchNewRows: (cursor) =>
          queryAgentsDb<OutreachConvoDbRow>(
            `
              select id, agent_slug, channel, source, lead_name, lead_handle, lead_company, status, last_at, msg_count${outreachTagSelect},
                     ${outreachSortExpr} as __sync_sort_at,
                     ${outreachIdExpr} as __sync_cursor_id
              from public.outreach_convos
              where ${scope.whereSql}
                and (${outreachSortExpr}, ${outreachIdExpr}) > ($1::timestamp, $2::text)
              order by ${outreachSortExpr} asc, ${outreachIdExpr} asc
              limit ${SYNC_NEW_BATCH_SIZE}
            `,
            [cursorTimestampParam(cursor.newestSyncedAt), cursor.newestSyncedId || '']
          ),
        fetchBackfillRows: (cursor) => {
          const hasBackfillCursor = !!cursor.backfillBeforeAt
          return queryAgentsDb<OutreachConvoDbRow>(
            `
              select id, agent_slug, channel, source, lead_name, lead_handle, lead_company, status, last_at, msg_count${outreachTagSelect},
                     ${outreachSortExpr} as __sync_sort_at,
                     ${outreachIdExpr} as __sync_cursor_id
              from public.outreach_convos
              where ${scope.whereSql}
              ${hasBackfillCursor ? `and (${outreachSortExpr}, ${outreachIdExpr}) < ($1::timestamp, $2::text)` : ''}
              order by ${outreachSortExpr} desc, ${outreachIdExpr} desc
              limit ${SYNC_BACKFILL_BATCH_SIZE}
            `,
            hasBackfillCursor ? [cursorTimestampParam(cursor.backfillBeforeAt), cursor.backfillBeforeId || ''] : []
          )
        },
      })
      const outreachConvos = outreachBatch?.rows || []

      if (outreachConvos.length > 0) {
        const convoIds = outreachConvos.map(c => c.id).filter(Boolean)
        const outreachMsgs = convoIds.length > 0 ? await queryAgentsDb<OutreachMsgDbRow>(`
          select id, convo_id, direction, status, subject, body, sent_at
          from public.outreach_msgs
          where convo_id = ANY($1)
          order by sent_at asc
        `, [convoIds]) : []

        const msgsByConvo = new Map<string, OutreachMsgDbRow[]>()
        if (outreachMsgs) {
          for (const m of outreachMsgs) {
            if (!msgsByConvo.has(m.convo_id)) msgsByConvo.set(m.convo_id, [])
            msgsByConvo.get(m.convo_id)!.push(m)
          }
        }

        for (const oc of outreachConvos) {
          const agentSlug = (oc.agent_slug || '').toLowerCase()
          let companySlug = 'autonomia'
          if (agentSlug.includes('gramado') || agentSlug.includes('plaza')) {
            companySlug = 'gramado-plaza'
          }

          const comp = companyMap.get(companySlug) || companyMap.get('autonomia')
          if (!comp) continue

          const rawHandle = (oc.lead_handle || '').trim()
          const isEmail = rawHandle.includes('@')
          const phone = isEmail ? rawHandle : normalizeDigits(rawHandle) || rawHandle
          if (!phone) continue

          const ch = oc.channel || (isEmail ? 'email' : 'whatsapp')
          const ocDate = oc.last_at ? new Date(oc.last_at) : new Date()
          const last9 = !isEmail && phone.length >= 9 ? phone.slice(-9) : phone

          let leadId = isEmail
            ? leadMap.get(`${comp.id}_${rawHandle.toLowerCase()}`)
            : (leadMap.get(`${comp.id}_${phone}`) || leadMap.get(`${comp.id}_${last9}`))
          const isExistingLead = !!leadId

          // Tags de mineração: as 4 (nicho/origem/temperatura/outreach_status)
          // só entram se a coluna existir na fonte (ver detectOutreachTagColumns
          // acima). "origem" aqui é a coluna NOVA com a origem real do lead
          // (google_places/instagram/linkedin/manual), NUNCA oc.source: essa é
          // uma constante fixa "prospeccao" (marcador de "é conversa de
          // prospecção" pro dashboard da Luana), sem relação com a origem real.
          // Nunca gravar chave vazia: um valor ausente não deve apagar uma tag
          // que já existia.
          const miningTagsPatch: { origem?: string; nicho?: string; temperatura?: string; statusRelacionamento?: string } = {}
          if (oc.origem) miningTagsPatch.origem = oc.origem
          if (oc.nicho) miningTagsPatch.nicho = oc.nicho
          if (oc.temperatura) miningTagsPatch.temperatura = oc.temperatura
          if (oc.outreach_status) miningTagsPatch.statusRelacionamento = oc.outreach_status
          const hasMiningTags = Object.keys(miningTagsPatch).length > 0

          if (!leadId) {
            const [newLead] = await db
              .insert(recoveryLeads)
              .values({
                companyId: comp.id,
                phone,
                email: isEmail ? rawHandle : null,
                name: oc.lead_name || `Lead ${phone.slice(-4)}`,
                productName: oc.lead_company || 'Prospecção / Mineração',
                platform: 'sac',
                channel: ch,
                eventType: oc.source || 'prospeccao',
                status: oc.status === 'active' ? 'in_conversation' : 'pending',
                trackingSource: 'mineracao_prospeccao',
                miningTags: hasMiningTags ? miningTagsPatch : undefined,
                createdAt: ocDate,
                updatedAt: ocDate,
                lastActionAt: ocDate,
              })
              .returning()

            leadId = newLead.id
            if (isEmail) {
              leadMap.set(`${comp.id}_${rawHandle.toLowerCase()}`, leadId)
            } else {
              leadMap.set(`${comp.id}_${phone}`, leadId)
              if (phone.length >= 9) leadMap.set(`${comp.id}_${last9}`, leadId)
            }
            leadsCreated++
          } else if (hasMiningTags) {
            // Lead já existia: faz merge (||) em cima do que já está gravado,
            // nunca overwrite cego. Assim uma sincronização com só "origem"
            // disponível não apaga um "nicho" já gravado numa passada anterior.
            await db
              .update(recoveryLeads)
              .set({
                miningTags: sql`COALESCE(${recoveryLeads.miningTags}, '{}'::jsonb) || ${JSON.stringify(miningTagsPatch)}::jsonb`,
                updatedAt: new Date(),
              })
              .where(eq(recoveryLeads.id, leadId))
          }

          const convoMsgs = msgsByConvo.get(oc.id) || []
          const msgsToInsert: (typeof whatsappMessages.$inferInsert)[] = []

          for (const m of convoMsgs) {
            const externalId = `outreach_${m.id}`
            if (existingMsgIds.has(externalId)) continue

            const isUser = m.direction === 'inbound'
            msgsToInsert.push({
              companyId: comp.id,
              leadId: leadId,
              phone: phone,
              channel: ch,
              direction: isUser ? 'inbound' : 'outbound',
              content: m.body || m.subject || '',
              messageType: 'text',
              sentBy: isUser ? 'user' : 'bot',
              externalId,
              createdAt: m.sent_at ? new Date(m.sent_at) : (oc.last_at ? new Date(oc.last_at) : new Date()),
            })
            existingMsgIds.add(externalId)
          }

          if (msgsToInsert.length > 0) {
            await db.insert(whatsappMessages).values(msgsToInsert)
            messagesImported += msgsToInsert.length

            // Mesmo raciocínio do bloco 3 (conversas de agente IA): lead já
            // existente precisa de um update explícito de lastActionAt, senão
            // o COALESCE de ordenação do Inbox ignora pra sempre a atividade
            // nova assim que lastActionAt for preenchido uma vez.
            if (isExistingLead) {
              const latestMsgDate = msgsToInsert.reduce(
                (max, m) => ((m.createdAt as Date) > max ? (m.createdAt as Date) : max),
                msgsToInsert[0].createdAt as Date
              )
              await db
                .update(recoveryLeads)
                .set({ lastActionAt: latestMsgDate, updatedAt: latestMsgDate })
                .where(eq(recoveryLeads.id, leadId))
            }
          }
        }
      }
      await outreachBatch?.markProcessed()
    }
  } catch (outreachErr) {
    details.push(`Aviso ao sincronizar prospecção: ${String(outreachErr)}`)
  }

  // 5. Sincroniza novos Leads do CRM em BATCH
  try {
    const targetComp = companyMap.get('autonomia') || companyMap.values().next().value
    if (targetComp) {
      const crmLeadSortExpr = `coalesce(created_at, first_contact_at, '${EPOCH_CURSOR_ISO}'::timestamp)`
      const crmLeadIdExpr = 'id::text'
      const crmLeadBatch = await loadTimedSyncBatch<CrmLeadDbRow>({
        companyId: targetComp.id,
        source: 'crm_leads',
        sourceKey: 'public',
        getPosition: crmLeadCursorPosition,
        fetchNewRows: (cursor) =>
          queryAgentsDb<CrmLeadDbRow>(
            `
              select id, organization_id, whatsapp, email, name, company, notes, value, status,
                     follow_up_date, follow_up_note, campaign_source, utm_source, utm_medium,
                     utm_campaign, utm_content, utm_term, ai_agent, created_at, first_contact_at,
                     ${crmLeadSortExpr} as __sync_sort_at,
                     ${crmLeadIdExpr} as __sync_cursor_id
              from public.leads
              where (${crmLeadSortExpr}, ${crmLeadIdExpr}) > ($1::timestamp, $2::text)
              order by ${crmLeadSortExpr} asc, ${crmLeadIdExpr} asc
              limit ${SYNC_NEW_BATCH_SIZE}
            `,
            [cursorTimestampParam(cursor.newestSyncedAt), cursor.newestSyncedId || '']
          ),
        fetchBackfillRows: (cursor) => {
          const hasBackfillCursor = !!cursor.backfillBeforeAt
          return queryAgentsDb<CrmLeadDbRow>(
            `
              select id, organization_id, whatsapp, email, name, company, notes, value, status,
                     follow_up_date, follow_up_note, campaign_source, utm_source, utm_medium,
                     utm_campaign, utm_content, utm_term, ai_agent, created_at, first_contact_at,
                     ${crmLeadSortExpr} as __sync_sort_at,
                     ${crmLeadIdExpr} as __sync_cursor_id
              from public.leads
              ${hasBackfillCursor ? `where (${crmLeadSortExpr}, ${crmLeadIdExpr}) < ($1::timestamp, $2::text)` : ''}
              order by ${crmLeadSortExpr} desc, ${crmLeadIdExpr} desc
              limit ${SYNC_BACKFILL_BATCH_SIZE}
            `,
            hasBackfillCursor ? [cursorTimestampParam(cursor.backfillBeforeAt), cursor.backfillBeforeId || ''] : []
          )
        },
      })
      const crmLeads = crmLeadBatch?.rows || []

      if (crmLeads.length > 0) {
        const leadsToInsert: (typeof recoveryLeads.$inferInsert)[] = []

        for (const l of crmLeads) {
          const rawPhone = (l.whatsapp || '').trim()
          const cleanPhone = normalizeDigits(rawPhone) || rawPhone
          const email = l.email ? l.email.trim().toLowerCase() : null
          if (!cleanPhone && !email) continue

          const last9 = cleanPhone && cleanPhone.length >= 9 ? cleanPhone.slice(-9) : null
          const existingId = (cleanPhone && leadMap.get(`${targetComp.id}_${cleanPhone}`)) ||
                             (last9 && leadMap.get(`${targetComp.id}_${last9}`)) ||
                             (email && leadMap.get(`${targetComp.id}_${email}`))

          if (!existingId) {
            const leadDate = l.created_at ? new Date(l.created_at) : (l.first_contact_at ? new Date(l.first_contact_at) : new Date())
            const prodVal = l.value ? Math.round(Number(l.value) * 100) : null
            const stage = l.status === 'converted' ? 'fechado' : (l.follow_up_date ? 'agendado' : 'qualificado')

            leadsToInsert.push({
              companyId: targetComp.id,
              phone: cleanPhone || email || '',
              email: email || undefined,
              name: l.name || l.company || ('Contato ' + (cleanPhone ? cleanPhone.slice(-4) : '')),
              productName: l.company || l.notes || 'Agente 24h / CRM',
              productValue: prodVal,
              platform: 'sac',
              channel: cleanPhone ? 'whatsapp' : 'email',
              eventType: l.campaign_source || 'prospeccao',
              status: l.status === 'converted' ? 'converted' : 'in_conversation',
              pipelineStage: stage,
              trackingSource: l.campaign_source || l.utm_source || 'mineracao_prospeccao',
              utmMedium: l.utm_medium,
              utmCampaign: l.utm_campaign,
              utmContent: l.utm_content,
              utmTerm: l.utm_term,
              responsibleAgent: l.ai_agent || 'Nina',
              followUpDate: l.follow_up_date ? new Date(l.follow_up_date) : undefined,
              followUpNote: l.follow_up_note,
              // Só marca como abordado se o CRM de origem confirma o primeiro contato.
              // Sem essa confirmação o lead entra no banco (aparece na lista), mas fica
              // de fora da contagem principal até uma mensagem de verdade ser trocada.
              firstContactAt: l.first_contact_at ? new Date(l.first_contact_at) : undefined,
              createdAt: leadDate,
              updatedAt: leadDate,
              lastActionAt: leadDate,
            })

            if (cleanPhone) leadMap.set(`${targetComp.id}_${cleanPhone}`, -1)
            if (last9) leadMap.set(`${targetComp.id}_${last9}`, -1)
            if (email) leadMap.set(`${targetComp.id}_${email}`, -1)
            leadsCreated++
          }
        }

        if (leadsToInsert.length > 0) {
          await db.insert(recoveryLeads).values(leadsToInsert)
          details.push(`${leadsToInsert.length} novos leads importados da base de CRM.`)
        }
      }
      await crmLeadBatch?.markProcessed()
    }
  } catch (crmErr) {
    details.push(`Aviso ao sincronizar CRM leads: ${String(crmErr)}`)
  }

  // 6. Sincroniza Referrals de Anúncios Click-to-WhatsApp (CTWA)
  try {
    const ctwaCursorCompany = companyMap.get('autonomia') || companyMap.values().next().value
    if (ctwaCursorCompany) {
      const ctwaColumns = await detectAgentsTableColumns('public', 'ctwa_referrals', ['id', 'ts', 'synced_at'])

      if (ctwaColumns.has('ts') || ctwaColumns.has('synced_at')) {
        const ctwaSortCandidates = [
          ctwaColumns.has('ts')
            ? `(to_timestamp((case when ts > 9999999999 then ts / 1000.0 else ts end)::double precision) at time zone 'UTC')`
            : null,
          ctwaColumns.has('synced_at') ? `(synced_at at time zone 'UTC')` : null,
          `'${EPOCH_CURSOR_ISO}'::timestamp`,
        ].filter((expr): expr is string => !!expr)
        const ctwaSortExpr = `coalesce(${ctwaSortCandidates.join(', ')})`
        const ctwaFallbackIdParts = [
          'phone_norm',
          'campaign_name',
          'ad_name',
          ctwaColumns.has('ts') ? 'ts::text' : null,
          ctwaColumns.has('synced_at') ? 'synced_at::text' : null,
        ].filter((expr): expr is string => !!expr).join(', ')
        const ctwaCursorIdExpr = ctwaColumns.has('id') ? 'id::text' : `concat_ws('|', ${ctwaFallbackIdParts})`
        const ctwaSelectColumns = [
          ctwaColumns.has('id') ? 'id' : null,
          'phone_norm',
          'campaign_name',
          'ad_name',
          ctwaColumns.has('ts') ? 'ts' : null,
          ctwaColumns.has('synced_at') ? 'synced_at' : null,
          `${ctwaSortExpr} as __sync_sort_at`,
          `${ctwaCursorIdExpr} as __sync_cursor_id`,
        ].filter((column): column is string => !!column).join(', ')
        const ctwaBatch = await loadTimedSyncBatch<CtwaReferralDbRow>({
          companyId: ctwaCursorCompany.id,
          source: 'ctwa_referrals',
          sourceKey: 'public',
          getPosition: ctwaCursorPosition,
          fetchNewRows: (cursor) =>
            queryAgentsDb<CtwaReferralDbRow>(
              `
                select ${ctwaSelectColumns}
                from public.ctwa_referrals
                where phone_norm is not null and length(phone_norm) >= 8
                  and (${ctwaSortExpr}, ${ctwaCursorIdExpr}) > ($1::timestamp, $2::text)
                order by ${ctwaSortExpr} asc, ${ctwaCursorIdExpr} asc
                limit ${SYNC_NEW_BATCH_SIZE}
              `,
              [cursorTimestampParam(cursor.newestSyncedAt), cursor.newestSyncedId || '']
            ),
          fetchBackfillRows: (cursor) => {
            const hasBackfillCursor = !!cursor.backfillBeforeAt
            return queryAgentsDb<CtwaReferralDbRow>(
              `
                select ${ctwaSelectColumns}
                from public.ctwa_referrals
                where phone_norm is not null and length(phone_norm) >= 8
                ${hasBackfillCursor ? `and (${ctwaSortExpr}, ${ctwaCursorIdExpr}) < ($1::timestamp, $2::text)` : ''}
                order by ${ctwaSortExpr} desc, ${ctwaCursorIdExpr} desc
                limit ${SYNC_BACKFILL_BATCH_SIZE}
              `,
              hasBackfillCursor ? [cursorTimestampParam(cursor.backfillBeforeAt), cursor.backfillBeforeId || ''] : []
            )
          },
        })
        const ctwaRows = ctwaBatch?.rows || []

        if (ctwaRows.length > 0) {
          let ctwaCount = 0
          for (const r of ctwaRows) {
            const norm = normalizeDigits(r.phone_norm)
            if (!norm) continue

            const updated = await db
              .update(recoveryLeads)
              .set({
                trackingSource: 'meta_ads',
                utmCampaign: r.campaign_name || undefined,
                updatedAt: new Date(),
              })
              .where(sql`right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9) = right(${norm}, 9)`)
              .returning({ id: recoveryLeads.id })

            if (updated.length > 0) ctwaCount++
          }
          if (ctwaCount > 0) {
            details.push(`${ctwaCount} leads identificados como Anúncios Meta (Janela de 72h).`)
          }
        }
        await ctwaBatch?.markProcessed()
      }
    }
  } catch {
    // Tabela opcional
  }

  // 7. Backfill de abordagem real: todo lead que ganhou mensagem de verdade
  // nesta sincronização (conversas do agente e outreach de mineração, blocos
  // 3 e 4 acima) mas ainda não tem first_contact_at, recebe a data da
  // primeira mensagem. Roda por último e sobre a base toda porque threads de
  // mensagens são inseridas em vários pontos acima; idempotente (só toca
  // quem está nulo), então não sobrescreve leads já marcados.
  try {
    await backfillFirstContactFromMessages()
  } catch (backfillErr) {
    details.push(`Aviso no backfill de first_contact_at: ${String(backfillErr)}`)
  }

  return {
    ok: true,
    message: `Sincronização concluída com sucesso. ${agents.length} agentes processados, ${leadsCreated} novos leads e ${messagesImported} mensagens importadas.`,
    agentsFound: agents.length,
    companiesCreated,
    leadsCreated,
    messagesImported,
    details,
    dbUrlUsed: dbUrlMasked,
  }
}
