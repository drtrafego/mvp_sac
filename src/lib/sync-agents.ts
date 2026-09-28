import { db } from '@/lib/db'
import { appointmentMirror, companies, settings, syncCursors, recoveryLeads, whatsappMessages, gramadoReservations } from '@/lib/db/schema'
import { queryAgentsDb, getAgentsDbUrl } from '@/lib/db/agents-db'
import { eq, and, sql, type SQL } from 'drizzle-orm'
import { backfillFirstContactFromMessages } from '@/lib/leads'
import {
  contactExactKey,
  readUniqueLeadLookup,
  rememberPhoneLeadLookup,
  rememberUniqueLeadLookup,
  resolvePhoneLeadLookup,
} from '@/lib/contact-resolution'

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
  cost_usd?: string | number | null
  input_tokens?: string | number | null
  output_tokens?: string | number | null
  synced_at?: string | null
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
  reasoning?: string | null
  sent_email?: string | null
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
  adset_name: string | null
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
  phone?: string | null
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

export interface AppointmentDbRow {
  id: string
  nome: string
  telefone: string | null
  telefone_norm: string | null
  data_consulta: string
  status: string
  origem: string | null
  cancelado_em: string | null
  synced_at: string
  __sync_sort_at?: string | Date | null
  __sync_cursor_id?: string | number | null
}

export interface GramadoReservationDbRow {
  reserva_id: string
  data: string
  horario_reservado: string | null
  horario_chegada: string | null
  telefone_norm: string | null
  pessoas: number | null
  valor_total: string | number | null
  status: string
  observacoes: string | null
  mesas_unificadas: boolean | null
  atualizado_em: string | null
  criado_em: string | null
  sincronizado_em: string | null
  __sync_sort_at?: string | Date | null
  __sync_cursor_id?: string | number | null
}

interface NativeCrmStateDbRow {
  id: string
  column_id: string
  column_title: string
  phone: string | null
  status: string | null
  follow_up_date: string | null
  follow_up_note: string | null
}

interface GramadoCrmLeadDbRow {
  id: string
  column_id: string | null
  column_title: string | null
  phone: string | null
  status: string | null
  follow_up_date: string | null
  follow_up_note: string | null
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

export function inferConversationChannel(cv: {
  channel?: string | null
  title?: string | null
  chat_id?: string | null
  session_id?: string | null
}): string {
  const ch = (cv.channel || '').toLowerCase().trim()
  const title = (cv.title || '').toLowerCase().trim()
  const chatId = (cv.chat_id || cv.session_id || '').toLowerCase().trim()

  // 1. Sinais explícitos de E-mail (canal, título contendo e-mail/brevo/webhook ou chatId com @)
  if (
    ch.includes('email') ||
    ch.includes('mail') ||
    ch.includes('brevo') ||
    ch.includes('webhook') ||
    ch.includes('smtp') ||
    chatId.includes('@') ||
    title.includes('e-mail') ||
    title.includes('email') ||
    title.includes('brevo')
  ) {
    return 'email'
  }

  // 2. Sinais explícitos de Instagram
  if (
    ch.includes('insta') ||
    ch.includes('ig') ||
    ch.includes('direct') ||
    chatId.startsWith('ig_') ||
    chatId.startsWith('instagram_') ||
    title.includes('instagram')
  ) {
    return 'instagram'
  }

  // 3. Sinais explícitos de WhatsApp
  if (
    ch.includes('whats') ||
    ch.includes('zap') ||
    ch.includes('wpp') ||
    ch.includes('uazapi') ||
    ch.includes('meta') ||
    ch.includes('ctwa')
  ) {
    return 'whatsapp'
  }

  // 4. Formato de telefone / números apenas (E.164)
  const digitsOnly = chatId.replace(/\D/g, '')
  if (digitsOnly.length >= 8 && !chatId.includes('@')) {
    return 'whatsapp'
  }

  // 5. Se o canal não bateu com nenhum padrão acima, registramos log de aviso
  if (ch) {
    console.warn(
      `[sync-agents] Canal não reconhecido na conversa: channel="${cv.channel}", title="${cv.title}", session_id="${cv.session_id}". Mapeado como "whatsapp" por fallback.`
    )
  }

  return 'whatsapp'
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

export interface NativeCrmLeadDbRow {
  id: string
  name: string | null
  phone: string | null
  email: string | null
  notes: string | null
  company: string | null
  value: string | number | null
  first_contact_at: string | null
  created_at: string | null
}

// Mapa telefone (dígitos limpos, chave cheia + últimos 9) -> nome da agenda.
// Só consulta quando a tabela existe no schema.
async function loadPhoneNameMap(
  schema: string,
  table: 'agendamentos'
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const exists = await tableExistsInAgentsDb(schema, table)
  if (!exists) return map

  const rows = await queryAgentsDb<AgendamentoDbRow>(`
    select nome, telefone, telefone_norm
    from "${schema}".agendamentos
    where nome is not null and trim(nome) <> ''
  `)

  for (const r of rows || []) {
    const rawName = r.nome
    const name = (rawName || '').trim()
    if (!name) continue

    const rawPhone = r.telefone_norm || r.telefone
    const norm = normalizeDigits(rawPhone)
    if (!norm) continue
    const last9 = norm.length >= 9 ? norm.slice(-9) : norm

    if (!map.has(norm)) map.set(norm, name)
    if (!map.has(last9)) map.set(last9, name)
  }

  return map
}

// Registro mais recente do CRM por telefone. A regra de desempate é explícita
// e estável: created_at mais novo vence; em timestamps iguais (ou nulos), o
// maior id vence. Como o mapa mantém a primeira ocorrência, a ordenação da
// query define deterministicamente nome e todos os metadados como um conjunto.
async function loadNativeCrmLeadMap(schema: string): Promise<Map<string, NativeCrmLeadDbRow>> {
  const map = new Map<string, NativeCrmLeadDbRow>()
  const exists = await tableExistsInAgentsDb(schema, 'crm_leads')
  if (!exists) return map

  const rows = await queryAgentsDb<NativeCrmLeadDbRow>(`
    select id, name, phone, email, notes, company, value, first_contact_at, created_at
    from "${schema}".crm_leads
    where phone is not null and trim(phone) <> ''
    order by created_at desc nulls last, id::text desc
  `)

  for (const row of rows || []) {
    const norm = normalizeDigits(row.phone)
    if (!norm) continue
    const last9 = norm.length >= 9 ? norm.slice(-9) : norm
    if (!map.has(norm)) map.set(norm, row)
    if (!map.has(last9)) map.set(last9, row)
  }

  return map
}

function crmValueInCents(value: string | number | null | undefined): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : undefined
}

function validDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
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

type SyncCursorSource = 'agent_conversations' | 'agent_conversation_metadata' | 'outreach_convos' | 'crm_leads' | 'ctwa_referrals' | 'appointments' | 'gramado_reservas'
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

// Sweep de migração que termina de verdade: ao chegar ao começo da fonte,
// grava um sentinela e deixa de consultar nas rodadas futuras. Usado só para
// retropreencher metadados históricos; novidades continuam no cursor normal.
async function loadBackfillOnlySyncBatch<T>(opts: {
  companyId: number
  source: SyncCursorSource
  sourceKey: string
  getPosition: (row: T) => CursorPosition | null
  fetchRows: (cursor: SyncCursorRow) => Promise<T[] | null>
}): Promise<{ rows: T[]; markProcessed: () => Promise<void> } | null> {
  const cursor = await getOrCreateSyncCursor(opts.companyId, opts.source, opts.sourceKey)
  if (cursor.backfillBeforeId === '__complete__') return null

  const rows = await opts.fetchRows(cursor)
  if (!rows) return null
  if (rows.length === 0) {
    await db.update(syncCursors).set({
      backfillBeforeAt: new Date(0),
      backfillBeforeId: '__complete__',
      lastRunAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(syncCursors.id, cursor.id))
    return null
  }

  return {
    rows,
    markProcessed: async () => {
      const oldest = pickOldestPosition(rows, opts.getPosition)
      if (!oldest) return
      const now = new Date()
      await db.update(syncCursors).set({
        backfillBeforeAt: oldest.at,
        backfillBeforeId: oldest.id,
        lastRunAt: now,
        updatedAt: now,
      }).where(eq(syncCursors.id, cursor.id))
    },
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

function appointmentCursorPosition(row: AppointmentDbRow): CursorPosition | null {
  return buildCursorPosition(row.__sync_sort_at ?? row.synced_at, row.__sync_cursor_id ?? row.id)
}

function nativePipelineStage(title: string): string {
  const normalized = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()

  const known: Record<string, string> = {
    'novo contato': 'novo_contato',
    atendimento: 'em_atendimento',
    'consulta agendada': 'agendado',
    compareceu: 'compareceu',
    perdido: 'perdido',
  }
  return known[normalized] || normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'novo_contato'
}

function gramadoReservationCursorPosition(row: GramadoReservationDbRow): CursorPosition | null {
  return buildCursorPosition(
    row.__sync_sort_at ?? row.atualizado_em ?? row.sincronizado_em ?? row.criado_em ?? EPOCH_CURSOR_ISO,
    row.__sync_cursor_id ?? row.reserva_id
  )
}

function gramadoPipelineStage(value: string | null | undefined): string {
  const normalized = (value || '').trim().toLocaleLowerCase('pt-BR')
  if (normalized.includes('reserva confirmada')) return 'agendado'
  if (normalized.includes('perdido')) return 'perdido'
  if (normalized.includes('novo contato')) return 'novo_contato'
  return normalized.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'novo_contato'
}

function gramadoLeadStatus(value: string | null | undefined): string {
  const normalized = (value || '').trim().toLocaleLowerCase('pt-BR')
  if (normalized.includes('reserva confirmada')) return 'completed'
  if (normalized.includes('perdido')) return 'lost'
  return 'in_conversation'
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
    row.__sync_cursor_id ?? row.id ?? `${row.phone_norm}|${row.campaign_name || ''}|${row.adset_name || ''}|${row.ad_name || ''}`
  )
}

// campaign_source também é usado pelo CRM para valores puramente técnicos.
// Só promovemos ao campo de origem quando a fonte nativa realmente acrescenta
// informação; assim um sync novo não troca uma atribuição real por outro
// "whatsapp_sac"/"agente_ia" genérico.
const GENERIC_CAMPAIGN_SOURCES = new Set([
  'whatsapp',
  'whatsapp_sac',
  'agente_ia',
  'atendimento',
  'atendimento_ia',
  'sac',
  'direct',
  'direto',
  'organic',
  'organico',
  'orgânico',
])

const MINERACAO_CAMPAIGN_SOURCES = ['mineracao', 'prospeccao', 'miner', 'mining', 'places']

export function realCampaignSource(value: string | null | undefined, allowMineracaoWords: boolean = false): string | null {
  const source = (value || '').trim()
  if (!source || GENERIC_CAMPAIGN_SOURCES.has(source.toLowerCase())) return null
  if (/^(ad|ads|an[uú]ncio|ctwa)$/i.test(source)) return 'meta_ads'
  if (!allowMineracaoWords && MINERACAO_CAMPAIGN_SOURCES.some((needle) => hasMineracaoWordBoundary(source, needle))) {
    return null
  }
  return source
}

// Usado só pelo bloco 4 (mineração), pra decidir se o trackingSource atual de
// um lead que a mineração confirma ter abordado (existe em outreach_convos)
// precisa ser corrigido pra 'mineracao_prospeccao'. Mesma lista de palavras
// de origins.ts (normalizeOrigin, bloco "1. Mineração") e
// inbox-channel-filter.ts (CATEGORY_RULES 'mineracao'): se mudar lá, mudar
// aqui também (já divergiu uma vez em produção, ver comentários nesses dois
// arquivos). Só dois casos são protegidos contra a correção (a atribuição já
// é mineração, ou já é um anúncio pago real e mais específico, ex.: CTWA);
// qualquer outro valor (inclusive defaults genéricos como 'agente_ia'/
// 'atendimento_ia' do bloco 3, ou um nativo do CRM tipo 'nina_outreach' do
// bloco 5) é sobrescrito, porque a fonte de verdade aqui É o outreach_convos
// da mineração, mais confiável que um default genérico de outro bloco.
function hasMineracaoWordBoundary(value: string | null | undefined, needle: string): boolean {
  const normalized = (value || '').normalize('NFD').replace(/\p{Mn}/gu, '')
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z])${escaped}`, 'i').test(normalized)
}

export function needsMineracaoTrackingSourceFix(currentTrackingSource: string | null | undefined): boolean {
  const alreadyMineracao = MINERACAO_CAMPAIGN_SOURCES.some((needle) =>
    hasMineracaoWordBoundary(currentTrackingSource, needle)
  )
  if (alreadyMineracao) return false

  const alreadyRealAds = ['meta_ads', 'fb_ads', 'facebook_ads', 'google_ads', 'gclid', 'adwords', 'gads'].some(
    (needle) => hasMineracaoWordBoundary(currentTrackingSource, needle)
  )
  if (alreadyRealAds) return false

  return true
}

type ClassifiedAgentCompany = {
  companySlug: string
  companyName: string
  knownTenantSlug: 'autonomia' | 'gramado-plaza' | 'drlucas' | null
}

export function classifyAgentCompany(rawSlugValue: string | null | undefined, rawNameValue: string | null | undefined): ClassifiedAgentCompany {
  const rawSlug = (rawSlugValue || '').trim().toLowerCase()
  const rawName = (rawNameValue || 'Agente IA').trim() || 'Agente IA'
  const normalizedName = rawName.toLowerCase()

  if (
    rawSlug.includes('autonomia') ||
    rawSlug.includes('gastao') ||
    rawSlug.includes('24horas') ||
    rawSlug.includes('casal') ||
    rawSlug.includes('trafego') ||
    normalizedName.includes('gast') ||
    normalizedName.includes('casal') ||
    normalizedName.includes('autonomia')
  ) {
    return { companySlug: 'autonomia', companyName: 'AutonomIA', knownTenantSlug: 'autonomia' }
  }

  if (rawSlug.includes('gramado') || rawSlug.includes('plaza')) {
    return { companySlug: 'gramado-plaza', companyName: 'Gramado Plaza', knownTenantSlug: 'gramado-plaza' }
  }

  if (rawSlug.includes('lucas') || normalizedName.includes('lucas')) {
    return { companySlug: 'drlucas', companyName: 'Dr. Lucas', knownTenantSlug: 'drlucas' }
  }

  return { companySlug: rawSlug, companyName: rawName, knownTenantSlug: null }
}

export async function syncAgentsAndCompanies(): Promise<SyncReport> {
  const details: string[] = []
  let companiesCreated = 0
  let leadsCreated = 0
  let messagesImported = 0
  let outreachUnknownOriginSkipped = 0

  const dbUrl = await getAgentsDbUrl()
  const dbUrlMasked = dbUrl ? dbUrl.replace(/:[^:@]+@/, ':****@') : 'Não configurado'

  // 1. Garante imediatamente as empresas principais no banco de dados local
  const defaultCompanies = [
    { name: 'AutonomIA', slug: 'autonomia' },
    { name: 'Gramado Plaza', slug: 'gramado-plaza' },
    { name: 'Dr. Lucas', slug: 'drlucas' },
  ]

  const companyMap = new Map<string, typeof companies.$inferSelect>()
  const agentScopes = new Map<string, {
    company: typeof companies.$inferSelect
    schema: string
  }>()

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
    .select({
      id: recoveryLeads.id,
      companyId: recoveryLeads.companyId,
      phone: recoveryLeads.phone,
      email: recoveryLeads.email,
      name: recoveryLeads.name,
      trackingSource: recoveryLeads.trackingSource,
      agentConversationId: recoveryLeads.agentConversationId,
      agentCostUsd: recoveryLeads.agentCostUsd,
      agentInputTokens: recoveryLeads.agentInputTokens,
      agentOutputTokens: recoveryLeads.agentOutputTokens,
      agentSyncedAt: recoveryLeads.agentSyncedAt,
      status: recoveryLeads.status,
      pipelineStage: recoveryLeads.pipelineStage,
      followUpDate: recoveryLeads.followUpDate,
      followUpNote: recoveryLeads.followUpNote,
    })
    .from(recoveryLeads)

  const leadMap = new Map<string, number>()
  const ambiguousLeadKeys = new Set<string>()
  // Nome atualmente salvo por lead (id -> name), usado só pra decidir se vale
  // a pena sobrescrever com um nome melhor no bloco 3 (ver resolveLeadName /
  // shouldUpdateLeadName acima). Mantido em memória e atualizado localmente
  // a cada troca nesta mesma rodada, pra não precisar reler do banco.
  const leadNameMap = new Map<number, string | null>()
  // trackingSource atualmente salvo por lead (id -> trackingSource), usado só
  // pelo bloco 4 (mineração) pra decidir se um lead que a mineração confirma
  // ter abordado (existe em outreach_convos) precisa ter a origem corrigida
  // pra mineração (ver needsMineracaoTrackingSourceFix abaixo). Bug real
  // encontrado em produção (23/09/2026, diagnóstico ad-hoc): quando o mesmo
  // telefone aparece primeiro no bloco 3 (agent_conversations, trackingSource
  // fixo 'agente_ia') ou no bloco 5 (crm_leads, pode reatribuir pra um valor
  // nativo tipo 'nina_outreach'), o lead nasce com isExistingLead=true na hora
  // em que o bloco 4 processa a mesma pessoa via outreach_convos — e o branch
  // de lead já existente do bloco 4 só fazia merge de miningTags, nunca
  // corrigia trackingSource. Resultado: o lead ficava pra sempre fora da aba
  // Mineração (origins.ts / inbox-channel-filter.ts), mesmo a mineração tendo
  // esse contato confirmado em outreach_convos.
  const leadTrackingSourceMap = new Map<number, string | null>()
  const leadConversationMetadata = new Map<number, {
    conversationId: string | null
    costUsd: string | null
    inputTokens: number | null
    outputTokens: number | null
    syncedAt: Date | null
  }>()
  const leadOperationalMap = new Map<number, {
    status: string | null
    pipelineStage: string | null
    followUpDate: Date | null
    followUpNote: string | null
  }>()
  for (const row of existingLeadsRows) {
    leadNameMap.set(row.id, row.name)
    leadTrackingSourceMap.set(row.id, row.trackingSource)
    leadConversationMetadata.set(row.id, {
      conversationId: row.agentConversationId,
      costUsd: row.agentCostUsd == null ? null : String(Number(row.agentCostUsd)),
      inputTokens: row.agentInputTokens,
      outputTokens: row.agentOutputTokens,
      syncedAt: row.agentSyncedAt,
    })
    leadOperationalMap.set(row.id, {
      status: row.status,
      pipelineStage: row.pipelineStage,
      followUpDate: row.followUpDate,
      followUpNote: row.followUpNote,
    })
    if (row.phone) {
      const clean = row.phone.replace(/\D/g, '') || row.phone
      rememberPhoneLeadLookup(leadMap, ambiguousLeadKeys, row.companyId, clean, row.id)
    }
    if (row.email) {
      rememberUniqueLeadLookup(leadMap, ambiguousLeadKeys, contactExactKey(row.companyId, row.email.trim().toLowerCase()), row.id)
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
    const { companySlug, companyName } = classifyAgentCompany(rawSlug, rawName)

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

    // Persiste o nome nativo enquanto não houver um override salvo em
    // Configurações. Depois de uma edição manual, o nome escolhido pelo usuário
    // tem precedência e não é revertido pelo cron.
    if (!company.agentDisplayNameManual && agent.name && agent.name.trim() && company.agentDisplayName !== agent.name.trim()) {
      const newAgentDisplayName = agent.name.trim()
      await db
        .update(companies)
        .set({ agentDisplayName: newAgentDisplayName, updatedAt: new Date() })
        .where(eq(companies.id, company.id))
      company.agentDisplayName = newAgentDisplayName
      companyMap.set(companySlug, company)
    }

    if (agent.schema_name) {
      agentScopes.set(`${company.id}:${agent.schema_name}`, {
        company,
        schema: agent.schema_name,
      })
    }

    // 3. Sincroniza Conversas e Mensagens do schema do agente em BATCH
    const schema = agent.schema_name
    if (schema) {
      try {
        // Alguns schemas legados (e bancos restaurados para teste) ainda não
        // têm todos os campos de auditoria. Alias tipado mantém o sync inteiro
        // funcionando e passa a copiar o campo automaticamente assim que ele
        // existir na fonte.
        const conversationMetadataColumns = await detectAgentsTableColumns(
          schema,
          'conversations',
          ['cost_usd', 'input_tokens', 'output_tokens', 'synced_at']
        )
        const conversationMetadataSelect = [
          conversationMetadataColumns.has('cost_usd') ? 'cost_usd' : 'null::numeric as cost_usd',
          conversationMetadataColumns.has('input_tokens') ? 'input_tokens' : 'null::bigint as input_tokens',
          conversationMetadataColumns.has('output_tokens') ? 'output_tokens' : 'null::bigint as output_tokens',
          conversationMetadataColumns.has('synced_at') ? 'synced_at' : 'null::timestamptz as synced_at',
        ].join(', ')
        const messageMetadataColumns = await detectAgentsTableColumns(
          schema,
          'messages',
          ['reasoning', 'sent_email']
        )
        const messageMetadataSelect = [
          messageMetadataColumns.has('reasoning') ? 'reasoning' : 'null::text as reasoning',
          messageMetadataColumns.has('sent_email') ? 'sent_email' : 'null::text as sent_email',
        ].join(', ')
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
                       ${conversationMetadataSelect},
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
                       ${conversationMetadataSelect},
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
        const metadataBackfillBatch = await loadBackfillOnlySyncBatch<ConversationDbRow>({
          companyId: company.id,
          source: 'agent_conversation_metadata',
          sourceKey: `${schema}:history-metadata-v1`,
          getPosition: conversationCursorPosition,
          fetchRows: (cursor) => {
            const hasBackfillCursor = !!cursor.backfillBeforeAt
            return queryAgentsDb<ConversationDbRow>(
              `
                select session_id, chat_id, channel, title, started_at, ended_at, message_count,
                       ${conversationMetadataSelect},
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
        const convs = dedupeTimedRows(
          [...(conversationBatch?.rows || []), ...(metadataBackfillBatch?.rows || [])],
          conversationCursorPosition
        )

        // Fontes melhores que o título da conversa (ver resolveLeadName
        // acima). Toleram schema sem essas tabelas: cada loader checa a
        // existência antes de consultar e devolve mapa vazio.
        const agendamentoNameByPhone = await loadPhoneNameMap(schema, 'agendamentos')
        const crmLeadByPhone = await loadNativeCrmLeadMap(schema)

        if (convs && convs.length > 0) {
          const sessionIds = convs.map(c => c.session_id).filter(Boolean)

          const msgs = sessionIds.length > 0 ? await queryAgentsDb<MessageDbRow>(`
            select id, session_id, role, content, ts, platform_message_id, ${messageMetadataSelect}
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

            // Retropreenche em lotes os metadados das mensagens que o
            // deduplicador já conhece. Não carrega reasoning/e-mails de TODO
            // o banco local na memória e não faz um UPDATE por mensagem.
            const metadataRows = msgs.flatMap(m => {
              const externalId = `agent_${schema}_${m.id || m.platform_message_id || m.session_id + '_' + m.ts}`
              return existingMsgIds.has(externalId)
                ? [{ externalId, reasoning: m.reasoning || null, sentEmail: m.sent_email || null }]
                : []
            })
            for (let offset = 0; offset < metadataRows.length; offset += 5_000) {
              const chunk = metadataRows.slice(offset, offset + 5_000)
              await db.execute(sql`
                update whatsapp_messages as local_message
                set reasoning = source_message.reasoning,
                    sent_email = source_message."sentEmail"
                from jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb)
                  as source_message("externalId" text, reasoning text, "sentEmail" text)
                where local_message.company_id = ${company.id}
                  and local_message.external_id = source_message."externalId"
                  and (
                    local_message.reasoning is distinct from source_message.reasoning
                    or local_message.sent_email is distinct from source_message."sentEmail"
                  )
              `)
            }
          }

          for (const cv of convs) {
            const rawPhone = cv.chat_id || cv.session_id
            if (!rawPhone) continue
            const cleanPhone = normalizeDigits(rawPhone) || rawPhone
            const last9 = cleanPhone.length >= 9 ? cleanPhone.slice(-9) : cleanPhone
            const crmLead = crmLeadByPhone.get(cleanPhone) || crmLeadByPhone.get(last9)

            let leadId = resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, company.id, cleanPhone)
            const isExistingLead = !!leadId
            const channelType = inferConversationChannel(cv)

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
              crmName: crmLead?.name,
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
                  email: crmLead?.email?.trim().toLowerCase() || undefined,
                  company: crmLead?.company || undefined,
                  notes: crmLead?.notes || undefined,
                  productValue: crmValueInCents(crmLead?.value),
                  firstContactAt: validDate(crmLead?.first_contact_at),
                  platform: 'sac',
                  channel: channelType,
                  eventType: 'atendimento_ia',
                  status: 'in_conversation',
                  trackingSource: companySlug === 'drlucas' ? 'whatsapp_sac' : 'agente_ia',
                  agentConversationId: cv.session_id,
                  agentCostUsd: cv.cost_usd == null ? null : String(cv.cost_usd),
                  agentInputTokens: cv.input_tokens == null ? null : Number(cv.input_tokens),
                  agentOutputTokens: cv.output_tokens == null ? null : Number(cv.output_tokens),
                  agentSyncedAt: cv.synced_at ? new Date(cv.synced_at) : null,
                  createdAt: cv.started_at ? new Date(cv.started_at) : new Date(),
                  updatedAt: leadDate,
                  lastActionAt: leadDate,
                })
                .returning()

              leadId = newLead.id
              rememberPhoneLeadLookup(leadMap, ambiguousLeadKeys, company.id, cleanPhone, leadId)
              leadNameMap.set(leadId, newLead.name)
              leadConversationMetadata.set(leadId, {
                conversationId: newLead.agentConversationId,
                costUsd: newLead.agentCostUsd == null ? null : String(Number(newLead.agentCostUsd)),
                inputTokens: newLead.agentInputTokens,
                outputTokens: newLead.agentOutputTokens,
                syncedAt: newLead.agentSyncedAt,
              })
              leadOperationalMap.set(leadId, {
                status: newLead.status,
                pipelineStage: newLead.pipelineStage,
                followUpDate: newLead.followUpDate,
                followUpNote: newLead.followUpNote,
              })
              leadsCreated++
            } else {
              // O registro CRM escolhido pela mesma regra determinística do
              // nome também enriquece leads já existentes. Campos ausentes na
              // fonte não apagam dados que chegaram de outro canal.
              if (crmLead) {
                const crmPatch: Partial<typeof recoveryLeads.$inferInsert> = {}
                const crmEmail = crmLead.email?.trim().toLowerCase()
                const crmValue = crmValueInCents(crmLead.value)
                const crmFirstContactAt = validDate(crmLead.first_contact_at)
                if (crmEmail) crmPatch.email = crmEmail
                if (crmLead.company) crmPatch.company = crmLead.company
                if (crmLead.notes) crmPatch.notes = crmLead.notes
                if (crmValue !== undefined) crmPatch.productValue = crmValue
                if (crmFirstContactAt) crmPatch.firstContactAt = crmFirstContactAt
                if (Object.keys(crmPatch).length > 0) {
                  await db.update(recoveryLeads).set(crmPatch).where(eq(recoveryLeads.id, leadId))
                  if (crmEmail) rememberUniqueLeadLookup(leadMap, ambiguousLeadKeys, contactExactKey(company.id, crmEmail), leadId)
                }
              }

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

            // A conversa nativa do Hermes é a fonte dos totais de custo e
            // tokens. Só escreve quando mudou, para o cron incremental não
            // gerar UPDATEs mortos em todas as conversas a cada rodada.
            const nextMetadata = {
              conversationId: cv.session_id,
              costUsd: cv.cost_usd == null ? null : String(Number(cv.cost_usd)),
              inputTokens: cv.input_tokens == null ? null : Number(cv.input_tokens),
              outputTokens: cv.output_tokens == null ? null : Number(cv.output_tokens),
              syncedAt: cv.synced_at ? new Date(cv.synced_at) : null,
            }
            const currentMetadata = leadConversationMetadata.get(leadId)
            const metadataChanged = !currentMetadata
              || currentMetadata.conversationId !== nextMetadata.conversationId
              || currentMetadata.costUsd !== nextMetadata.costUsd
              || currentMetadata.inputTokens !== nextMetadata.inputTokens
              || currentMetadata.outputTokens !== nextMetadata.outputTokens
              || currentMetadata.syncedAt?.getTime() !== nextMetadata.syncedAt?.getTime()
            if (metadataChanged) {
              await db
                .update(recoveryLeads)
                .set({
                  agentConversationId: nextMetadata.conversationId,
                  agentCostUsd: nextMetadata.costUsd,
                  agentInputTokens: nextMetadata.inputTokens,
                  agentOutputTokens: nextMetadata.outputTokens,
                  agentSyncedAt: nextMetadata.syncedAt,
                })
                .where(eq(recoveryLeads.id, leadId))
              leadConversationMetadata.set(leadId, nextMetadata)
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
                reasoning: m.reasoning || null,
                sentEmail: m.sent_email || null,
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
        await metadataBackfillBatch?.markProcessed()
      } catch (convErr) {
        details.push(`Aviso ao sincronizar conversas do schema "${schema}": ${String(convErr)}`)
      }

      // Espelho da agenda e estado do CRM nativo do Dr. Lucas. Este fluxo é
      // estritamente Agents DB -> SAC: nenhuma query de escrita toca o schema
      // do bot. A agenda tem synced_at e usa o mesmo cursor bidirecional das
      // demais fontes. crm_leads não tem updated_at; como seus campos são
      // mutáveis, a reconciliação completa (hoje < 200 linhas) é necessária
      // para não perder mudanças de coluna/follow-up em registros antigos.
      if (companySlug === 'drlucas') {
        try {
          if (await tableExistsInAgentsDb(schema, 'agendamentos')) {
            const appointmentSortExpr = 'synced_at'
            const appointmentIdExpr = 'id::text'
            const appointmentBatch = await loadTimedSyncBatch<AppointmentDbRow>({
              companyId: company.id,
              source: 'appointments',
              sourceKey: schema,
              getPosition: appointmentCursorPosition,
              fetchNewRows: (cursor) =>
                queryAgentsDb<AppointmentDbRow>(
                  `
                    select id, nome, telefone, telefone_norm, data_consulta, status,
                           origem, cancelado_em, synced_at,
                           ${appointmentSortExpr} as __sync_sort_at,
                           ${appointmentIdExpr} as __sync_cursor_id
                    from "${schema}".agendamentos
                    where (${appointmentSortExpr}, ${appointmentIdExpr}) > ($1::timestamptz, $2::text)
                    order by ${appointmentSortExpr} asc, ${appointmentIdExpr} asc
                    limit ${SYNC_NEW_BATCH_SIZE}
                  `,
                  [cursorTimestampParam(cursor.newestSyncedAt), cursor.newestSyncedId || '']
                ),
              fetchBackfillRows: (cursor) => {
                const hasBackfillCursor = !!cursor.backfillBeforeAt
                return queryAgentsDb<AppointmentDbRow>(
                  `
                    select id, nome, telefone, telefone_norm, data_consulta, status,
                           origem, cancelado_em, synced_at,
                           ${appointmentSortExpr} as __sync_sort_at,
                           ${appointmentIdExpr} as __sync_cursor_id
                    from "${schema}".agendamentos
                    ${hasBackfillCursor ? `where (${appointmentSortExpr}, ${appointmentIdExpr}) < ($1::timestamptz, $2::text)` : ''}
                    order by ${appointmentSortExpr} desc, ${appointmentIdExpr} desc
                    limit ${SYNC_BACKFILL_BATCH_SIZE}
                  `,
                  hasBackfillCursor ? [cursorTimestampParam(cursor.backfillBeforeAt), cursor.backfillBeforeId || ''] : []
                )
              },
            })

            for (const appointment of appointmentBatch?.rows || []) {
              const sourceSyncedAt = new Date(appointment.synced_at)
              const consultationAt = new Date(appointment.data_consulta)
              if (Number.isNaN(sourceSyncedAt.getTime()) || Number.isNaN(consultationAt.getTime())) continue

              const values = {
                companyId: company.id,
                nativeId: appointment.id,
                name: appointment.nome,
                phone: appointment.telefone,
                phoneNorm: normalizeDigits(appointment.telefone_norm || appointment.telefone) || null,
                consultationAt,
                status: appointment.status,
                origin: appointment.origem,
                cancelledAt: appointment.cancelado_em ? new Date(appointment.cancelado_em) : null,
                sourceSyncedAt,
                mirroredAt: new Date(),
              }
              await db
                .insert(appointmentMirror)
                .values(values)
                .onConflictDoUpdate({
                  target: [appointmentMirror.companyId, appointmentMirror.nativeId],
                  set: values,
                })
            }
            await appointmentBatch?.markProcessed()
            if (appointmentBatch?.rows.length) {
              details.push(`${appointmentBatch.rows.length} consultas do Dr. Lucas espelhadas.`)
            }
          }

          if (await tableExistsInAgentsDb(schema, 'crm_leads')) {
            const nativeCrmLeads = await queryAgentsDb<NativeCrmStateDbRow>(`
              select l.id, l.column_id, c.title as column_title, l.phone, l.status,
                     l.follow_up_date, l.follow_up_note
              from "${schema}".crm_leads l
              join "${schema}".crm_columns c on c.id = l.column_id
            `)
            let reconciled = 0
            for (const nativeLead of nativeCrmLeads || []) {
              const cleanPhone = normalizeDigits(nativeLead.phone)
              if (!cleanPhone) continue
              const leadId = resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, company.id, cleanPhone)
              if (!leadId || leadId < 1) continue

              await db
                .update(recoveryLeads)
                .set({
                  pipelineStage: nativePipelineStage(nativeLead.column_title),
                  status: nativeLead.status,
                  followUpDate: nativeLead.follow_up_date ? new Date(nativeLead.follow_up_date) : null,
                  followUpNote: nativeLead.follow_up_note,
                })
                .where(and(eq(recoveryLeads.id, leadId), eq(recoveryLeads.companyId, company.id)))
              reconciled++
            }
            if (reconciled) details.push(`${reconciled} leads do Dr. Lucas reconciliados com o CRM nativo.`)
          }
        } catch (mirrorErr) {
          details.push(`Aviso ao sincronizar agenda/CRM nativo do Dr. Lucas: ${String(mirrorErr)}`)
        }
      }

      // 3.1. Gramado: espelho operacional de reservas e estado nativo do CRM.
      // Reservas usam cursor por atualizado_em + reserva_id: uma alteração
      // de status/horário entra como novidade mesmo quando a reserva foi criada
      // meses atrás. crm_leads não possui updated_at na fonte real, portanto
      // seu conjunto pequeno é reconciliado por estado a cada rodada.
      if (schema === 'gramadoplazza' && companySlug === 'gramado-plaza') {
        try {
          const reservationSortExpr = `coalesce(atualizado_em, sincronizado_em, criado_em, '${EPOCH_CURSOR_ISO}'::timestamptz)`
          const reservationIdExpr = 'reserva_id::text'
          const selectReservationColumns = `
            reserva_id, data, horario_reservado, horario_chegada, telefone_norm,
            pessoas, valor_total, status, observacoes, mesas_unificadas,
            atualizado_em, criado_em, sincronizado_em,
            ${reservationSortExpr} as __sync_sort_at,
            ${reservationIdExpr} as __sync_cursor_id
          `
          const reservationBatch = await loadTimedSyncBatch<GramadoReservationDbRow>({
            companyId: company.id,
            source: 'gramado_reservas',
            sourceKey: schema,
            getPosition: gramadoReservationCursorPosition,
            fetchNewRows: (cursor) => queryAgentsDb<GramadoReservationDbRow>(
              `
                select ${selectReservationColumns}
                from "${schema}".reservas
                where (${reservationSortExpr}, ${reservationIdExpr}) > ($1::timestamptz, $2::text)
                order by ${reservationSortExpr} asc, ${reservationIdExpr} asc
                limit ${SYNC_NEW_BATCH_SIZE}
              `,
              [cursorTimestampParam(cursor.newestSyncedAt), cursor.newestSyncedId || '']
            ),
            fetchBackfillRows: (cursor) => {
              const hasBackfillCursor = !!cursor.backfillBeforeAt
              return queryAgentsDb<GramadoReservationDbRow>(
                `
                  select ${selectReservationColumns}
                  from "${schema}".reservas
                  ${hasBackfillCursor ? `where (${reservationSortExpr}, ${reservationIdExpr}) < ($1::timestamptz, $2::text)` : ''}
                  order by ${reservationSortExpr} desc, ${reservationIdExpr} desc
                  limit ${SYNC_BACKFILL_BATCH_SIZE}
                `,
                hasBackfillCursor ? [cursorTimestampParam(cursor.backfillBeforeAt), cursor.backfillBeforeId || ''] : []
              )
            },
          })

          for (const reservation of reservationBatch?.rows || []) {
            const phoneNorm = normalizeDigits(reservation.telefone_norm)
            const leadId = phoneNorm
              ? resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, company.id, phoneNorm) || null
              : null
            const atualizadoEm = parseCursorDate(
              reservation.atualizado_em || reservation.sincronizado_em || reservation.criado_em
            )
            const values: typeof gramadoReservations.$inferInsert = {
              companyId: company.id,
              leadId,
              reservaId: String(reservation.reserva_id),
              phoneNorm: phoneNorm || null,
              data: String(reservation.data).slice(0, 10),
              horarioReservado: reservation.horario_reservado,
              horarioChegada: reservation.horario_chegada,
              pessoas: reservation.pessoas,
              valorTotal: reservation.valor_total == null ? null : String(reservation.valor_total),
              status: reservation.status,
              observacoes: reservation.observacoes,
              mesasUnificadas: reservation.mesas_unificadas,
              atualizadoEm,
              syncedAt: new Date(),
            }

            await db
              .insert(gramadoReservations)
              .values(values)
              .onConflictDoUpdate({
                target: [gramadoReservations.companyId, gramadoReservations.reservaId],
                set: {
                  leadId: values.leadId,
                  phoneNorm: values.phoneNorm,
                  data: values.data,
                  horarioReservado: values.horarioReservado,
                  horarioChegada: values.horarioChegada,
                  pessoas: values.pessoas,
                  valorTotal: values.valorTotal,
                  status: values.status,
                  observacoes: values.observacoes,
                  mesasUnificadas: values.mesasUnificadas,
                  atualizadoEm: values.atualizadoEm,
                  syncedAt: values.syncedAt,
                },
              })
          }
          await reservationBatch?.markProcessed()
          if (reservationBatch?.rows.length) {
            details.push(`${reservationBatch.rows.length} reservas do Gramado reconciliadas.`)
          }

          const nativeCrmLeads = await queryAgentsDb<GramadoCrmLeadDbRow>(`
            select l.id, l.column_id, c.title as column_title, l.phone, l.status,
                   l.follow_up_date, l.follow_up_note
            from "${schema}".crm_leads l
            left join "${schema}".crm_columns c on c.id = l.column_id
          `)

          let nativeCrmUpdates = 0
          for (const nativeLead of nativeCrmLeads || []) {
            const phone = normalizeDigits(nativeLead.phone)
            if (!phone) continue
            const leadId = resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, company.id, phone)
            if (!leadId) continue

            const sourceStage = nativeLead.column_title || nativeLead.status
            const next = {
              pipelineStage: gramadoPipelineStage(sourceStage),
              status: gramadoLeadStatus(nativeLead.status || nativeLead.column_title),
              followUpDate: nativeLead.follow_up_date ? new Date(nativeLead.follow_up_date) : null,
              followUpNote: nativeLead.follow_up_note || null,
            }
            const current = leadOperationalMap.get(leadId)
            const currentFollowUpMs = current?.followUpDate?.getTime() ?? null
            const nextFollowUpMs = next.followUpDate && !Number.isNaN(next.followUpDate.getTime())
              ? next.followUpDate.getTime()
              : null
            if (
              current?.pipelineStage === next.pipelineStage &&
              current?.status === next.status &&
              currentFollowUpMs === nextFollowUpMs &&
              current?.followUpNote === next.followUpNote
            ) continue

            await db.update(recoveryLeads).set({
              pipelineStage: next.pipelineStage,
              status: next.status,
              followUpDate: nextFollowUpMs == null ? null : next.followUpDate,
              followUpNote: next.followUpNote,
              updatedAt: new Date(),
            }).where(eq(recoveryLeads.id, leadId))
            leadOperationalMap.set(leadId, {
              ...next,
              followUpDate: nextFollowUpMs == null ? null : next.followUpDate,
            })
            nativeCrmUpdates++
          }
          if (nativeCrmUpdates) details.push(`${nativeCrmUpdates} leads do Gramado atualizados pelo CRM nativo.`)
        } catch (reservationErr) {
          details.push(`Aviso ao sincronizar reservas/CRM do Gramado: ${String(reservationErr)}`)
        }
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
    const outreachKnownAgentSlugSql = [
      "coalesce(agent_slug, '') ilike '%autonomia%'",
      "coalesce(agent_slug, '') ilike '%gastao%'",
      "coalesce(agent_slug, '') ilike '%24horas%'",
      "coalesce(agent_slug, '') ilike '%casal%'",
      "coalesce(agent_slug, '') ilike '%trafego%'",
      "coalesce(agent_slug, '') ilike '%gramado%'",
      "coalesce(agent_slug, '') ilike '%plaza%'",
      "coalesce(agent_slug, '') ilike '%lucas%'",
    ].join(' or ')
    const outreachScopes = [
      {
        sourceKey: 'autonomia',
        company: companyMap.get('autonomia'),
        whereSql: "(coalesce(agent_slug, '') ilike '%autonomia%' or coalesce(agent_slug, '') ilike '%gastao%' or coalesce(agent_slug, '') ilike '%24horas%' or coalesce(agent_slug, '') ilike '%casal%' or coalesce(agent_slug, '') ilike '%trafego%')",
      },
      {
        sourceKey: 'gramado-plaza',
        company: companyMap.get('gramado-plaza'),
        whereSql: "(coalesce(agent_slug, '') ilike '%gramado%' or coalesce(agent_slug, '') ilike '%plaza%')",
      },
    ]

    const quarantineCursorCompany = companyMap.get('autonomia')
    if (quarantineCursorCompany) {
      const unknownOutreachBatch = await loadTimedSyncBatch<OutreachConvoDbRow>({
        companyId: quarantineCursorCompany.id,
        source: 'outreach_convos',
        sourceKey: 'unknown-origin-quarantine',
        getPosition: outreachCursorPosition,
        fetchNewRows: (cursor) =>
          queryAgentsDb<OutreachConvoDbRow>(
            `
              select id, agent_slug, channel, source, lead_name, lead_handle, lead_company, status, last_at, msg_count${outreachTagSelect},
                     ${outreachSortExpr} as __sync_sort_at,
                     ${outreachIdExpr} as __sync_cursor_id
              from public.outreach_convos
              where not (${outreachKnownAgentSlugSql})
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
              where not (${outreachKnownAgentSlugSql})
              ${hasBackfillCursor ? `and (${outreachSortExpr}, ${outreachIdExpr}) < ($1::timestamp, $2::text)` : ''}
              order by ${outreachSortExpr} desc, ${outreachIdExpr} desc
              limit ${SYNC_BACKFILL_BATCH_SIZE}
            `,
            hasBackfillCursor ? [cursorTimestampParam(cursor.backfillBeforeAt), cursor.backfillBeforeId || ''] : []
          )
        },
      })
      outreachUnknownOriginSkipped += unknownOutreachBatch?.rows.length || 0
      await unknownOutreachBatch?.markProcessed()
    }

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
          const classifiedCompany = classifyAgentCompany(oc.agent_slug, null)
          if (!classifiedCompany.knownTenantSlug) {
            outreachUnknownOriginSkipped++
            continue
          }
          if (classifiedCompany.knownTenantSlug === 'drlucas') continue

          const comp = companyMap.get(classifiedCompany.companySlug)
          if (!comp) continue

          const rawHandle = (oc.lead_handle || '').trim()
          const isEmail = rawHandle.includes('@')
          const phone = isEmail ? rawHandle : normalizeDigits(rawHandle) || rawHandle
          if (!phone) continue

          const ch = oc.channel || (isEmail ? 'email' : 'whatsapp')
          const ocDate = oc.last_at ? new Date(oc.last_at) : new Date()

          let leadId = isEmail
            ? readUniqueLeadLookup(leadMap, ambiguousLeadKeys, contactExactKey(comp.id, rawHandle.toLowerCase()))
            : resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, comp.id, phone)
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
              rememberUniqueLeadLookup(leadMap, ambiguousLeadKeys, contactExactKey(comp.id, rawHandle.toLowerCase()), leadId)
            } else {
              rememberPhoneLeadLookup(leadMap, ambiguousLeadKeys, comp.id, phone, leadId)
            }
            leadTrackingSourceMap.set(leadId, 'mineracao_prospeccao')
            leadsCreated++
          } else {
            // Lead já existia (criado antes por outro bloco, ex.: bloco 3 via
            // agent_conversations, ou bloco 5 via crm_leads). Bug real
            // confirmado em produção (23/09/2026, 40 leads da AutonomIA): o
            // bloco 3 roda ANTES deste bloco 4 no mesmo agente e cria o lead
            // primeiro com trackingSource genérico ('agente_ia') ou o bloco 5
            // depois reatribui pra um valor nativo do CRM ('nina_outreach');
            // como este branch só fazia merge de miningTags, o lead ficava
            // pra sempre fora da aba Mineração mesmo estando confirmado em
            // outreach_convos. needsMineracaoTrackingSourceFix só poupa quem
            // já é mineração ou já tem atribuição de anúncio pago real (mais
            // específica); todo o resto é corrigido pra mineracao_prospeccao,
            // porque outreach_convos é a fonte de verdade de quem a mineração
            // abordou de fato, independente da pessoa já ter respondido.
            const updatePatch: { miningTags?: SQL; trackingSource?: string; updatedAt: Date } = {
              updatedAt: new Date(),
            }
            if (hasMiningTags) {
              // Merge (||) em cima do que já está gravado, nunca overwrite
              // cego: uma sincronização com só "origem" disponível não pode
              // apagar um "nicho" já gravado numa passada anterior.
              updatePatch.miningTags = sql`COALESCE(${recoveryLeads.miningTags}, '{}'::jsonb) || ${JSON.stringify(miningTagsPatch)}::jsonb`
            }
            if (needsMineracaoTrackingSourceFix(leadTrackingSourceMap.get(leadId))) {
              updatePatch.trackingSource = 'mineracao_prospeccao'
            }
            if (updatePatch.miningTags !== undefined || updatePatch.trackingSource !== undefined) {
              await db.update(recoveryLeads).set(updatePatch).where(eq(recoveryLeads.id, leadId))
              if (updatePatch.trackingSource) leadTrackingSourceMap.set(leadId, updatePatch.trackingSource)
            }
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
  if (outreachUnknownOriginSkipped > 0) {
    details.push(`${outreachUnknownOriginSkipped} conversas de prospecção ignoradas por origem desconhecida/quarentena.`)
  }

  // 5. Sincroniza o CRM nativo de CADA schema de agente. Antes este bloco lia
  // public.leads e atribuía tudo à AutonomIA; a fonte real é
  // <schema-do-agente>.crm_leads. Além de importar novos registros, enriquece
  // leads já criados pelo bloco de conversas com campaign_source/UTMs reais.
  for (const scope of agentScopes.values()) {
    // Só a AutonomIA libera palavra reservada de mineração vinda do CRM
    // nativo (campaign_source/utm_source em texto livre). Isso é
    // DELIBERADAMENTE mais restrito que o bloco 4 (outreach_convos), que já
    // trata o Gramado Plaza como outreach válido quando há uma linha real
    // de abordagem lá — porque outreach_convos é a fonte de verdade
    // (evidência por conversa), enquanto campaign_source é texto livre sem
    // garantia nenhuma (foi exatamente uma anotação livre com a palavra
    // "prospeccao" no CRM do Gramado que causou o badge de Mineração falso
    // corrigido em 27/09/2026 — ver commit "neutraliza palavra reservada de
    // mineração fora de empresa outreach"). NÃO amplie esta lista pra
    // incluir 'gramado-plaza' ou qualquer outro slug sem antes confirmar que
    // a fonte específica (crm_leads) realmente prova outreach pra aquela
    // empresa — senão reabre o mesmo bug.
    const isOutreachCompany = scope.company.slug === 'autonomia'
    try {
      const crmColumns = await detectAgentsTableColumns(scope.schema, 'crm_leads', [
        'id', 'organization_id', 'whatsapp', 'phone', 'email', 'name', 'company', 'notes', 'value', 'status',
        'follow_up_date', 'follow_up_note', 'campaign_source', 'utm_source', 'utm_medium', 'utm_campaign',
        'utm_content', 'utm_term', 'ai_agent', 'created_at', 'first_contact_at',
      ])
      if (!crmColumns.has('id') || (!crmColumns.has('whatsapp') && !crmColumns.has('phone'))) continue

      const col = (name: string, fallback = 'null::text') => crmColumns.has(name) ? name : `${fallback} as ${name}`
      const phoneExpr = crmColumns.has('whatsapp') ? 'whatsapp' : 'phone'
      const sortParts = [
        crmColumns.has('created_at') ? 'created_at' : null,
        crmColumns.has('first_contact_at') ? 'first_contact_at' : null,
        `'${EPOCH_CURSOR_ISO}'::timestamp`,
      ].filter((part): part is string => !!part)
      const crmLeadSortExpr = `coalesce(${sortParts.join(', ')})`
      const crmLeadIdExpr = 'id::text'
      const selectColumns = [
        'id::text as id',
        col('organization_id'),
        `${phoneExpr} as whatsapp`,
        col('email'), col('name'), col('company'), col('notes'), col('value', 'null::numeric'), col('status'),
        col('follow_up_date', 'null::timestamp'), col('follow_up_note'), col('campaign_source'), col('utm_source'),
        col('utm_medium'), col('utm_campaign'), col('utm_content'), col('utm_term'), col('ai_agent'),
        col('created_at', 'null::timestamp'), col('first_contact_at', 'null::timestamp'),
        `${crmLeadSortExpr} as __sync_sort_at`,
        `${crmLeadIdExpr} as __sync_cursor_id`,
      ].join(', ')
      const sourceTable = `"${scope.schema.replace(/"/g, '""')}".crm_leads`
      const crmLeadBatch = await loadTimedSyncBatch<CrmLeadDbRow>({
        companyId: scope.company.id,
        source: 'crm_leads',
        sourceKey: scope.schema,
        getPosition: crmLeadCursorPosition,
        fetchNewRows: (cursor) => queryAgentsDb<CrmLeadDbRow>(
          `select ${selectColumns} from ${sourceTable}
           where (${crmLeadSortExpr}, ${crmLeadIdExpr}) > ($1::timestamp, $2::text)
           order by ${crmLeadSortExpr} asc, ${crmLeadIdExpr} asc limit ${SYNC_NEW_BATCH_SIZE}`,
          [cursorTimestampParam(cursor.newestSyncedAt), cursor.newestSyncedId || '']
        ),
        fetchBackfillRows: (cursor) => {
          const hasBackfillCursor = !!cursor.backfillBeforeAt
          return queryAgentsDb<CrmLeadDbRow>(
            `select ${selectColumns} from ${sourceTable}
             ${hasBackfillCursor ? `where (${crmLeadSortExpr}, ${crmLeadIdExpr}) < ($1::timestamp, $2::text)` : ''}
             order by ${crmLeadSortExpr} desc, ${crmLeadIdExpr} desc limit ${SYNC_BACKFILL_BATCH_SIZE}`,
            hasBackfillCursor ? [cursorTimestampParam(cursor.backfillBeforeAt), cursor.backfillBeforeId || ''] : []
          )
        },
      })

      let insertedFromScope = 0
      let attributedFromScope = 0
      for (const l of crmLeadBatch?.rows || []) {
        const rawPhone = (l.whatsapp || l.phone || '').trim()
        const cleanPhone = normalizeDigits(rawPhone) || rawPhone
        const email = l.email ? l.email.trim().toLowerCase() : null
        if (!cleanPhone && !email) continue

        const existingId = (cleanPhone && resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, scope.company.id, cleanPhone)) ||
          (email && readUniqueLeadLookup(leadMap, ambiguousLeadKeys, contactExactKey(scope.company.id, email)))
        const nativeSource = realCampaignSource(l.campaign_source, isOutreachCompany) || realCampaignSource(l.utm_source, isOutreachCompany)

        if (existingId && existingId > 0) {
          const attributionPatch: Omit<Partial<typeof recoveryLeads.$inferInsert>,
            'trackingSource' | 'utmMedium' | 'utmCampaign' | 'utmContent' | 'utmTerm'> & {
            trackingSource?: string | SQL
            utmMedium?: string | SQL
            utmCampaign?: string | SQL
            utmContent?: string | SQL
            utmTerm?: string | SQL
          } = {}
          if (nativeSource) {
            attributionPatch.trackingSource = sql`case
              when coalesce(trim(${recoveryLeads.trackingSource}), '') = ''
                or lower(trim(${recoveryLeads.trackingSource})) in
                  ('whatsapp', 'whatsapp_sac', 'agente_ia', 'atendimento', 'atendimento_ia', 'sac', 'direct', 'direto', 'organic', 'organico', 'orgânico')
              then ${nativeSource}
              else ${recoveryLeads.trackingSource}
            end`
          }
          if (l.utm_medium) attributionPatch.utmMedium = sql`coalesce(nullif(${recoveryLeads.utmMedium}, ''), ${l.utm_medium})`
          if (l.utm_campaign) attributionPatch.utmCampaign = sql`coalesce(nullif(${recoveryLeads.utmCampaign}, ''), ${l.utm_campaign})`
          if (l.utm_content) attributionPatch.utmContent = sql`coalesce(nullif(${recoveryLeads.utmContent}, ''), ${l.utm_content})`
          if (l.utm_term) attributionPatch.utmTerm = sql`coalesce(nullif(${recoveryLeads.utmTerm}, ''), ${l.utm_term})`
          if (Object.keys(attributionPatch).length > 0) {
            attributionPatch.updatedAt = new Date()
            await db.update(recoveryLeads).set(attributionPatch).where(eq(recoveryLeads.id, existingId))
            attributedFromScope++
          }
          continue
        }
        if (existingId) continue

        const leadDate = l.created_at ? new Date(l.created_at) : (l.first_contact_at ? new Date(l.first_contact_at) : new Date())
        const prodVal = l.value ? Math.round(Number(l.value) * 100) : null
        const stage = l.status === 'converted' ? 'fechado' : (l.follow_up_date ? 'agendado' : 'qualificado')
        const [newLead] = await db.insert(recoveryLeads).values({
          companyId: scope.company.id,
          phone: cleanPhone || email || '',
          email: email || undefined,
          name: l.name || l.company || ('Contato ' + (cleanPhone ? cleanPhone.slice(-4) : '')),
          productName: l.company || l.notes || 'Agente 24h / CRM',
          productValue: prodVal,
          platform: 'sac',
          channel: cleanPhone ? 'whatsapp' : 'email',
          eventType: nativeSource || (isOutreachCompany ? 'prospeccao' : 'atendimento_ia'),
          status: l.status === 'converted' ? 'converted' : 'in_conversation',
          pipelineStage: stage,
          trackingSource: nativeSource || (isOutreachCompany ? 'mineracao_prospeccao' : undefined),
          utmMedium: l.utm_medium,
          utmCampaign: l.utm_campaign,
          utmContent: l.utm_content,
          utmTerm: l.utm_term,
          responsibleAgent: l.ai_agent || scope.company.agentDisplayName || undefined,
          followUpDate: l.follow_up_date ? new Date(l.follow_up_date) : undefined,
          followUpNote: l.follow_up_note,
          firstContactAt: l.first_contact_at ? new Date(l.first_contact_at) : undefined,
          createdAt: leadDate,
          updatedAt: leadDate,
          lastActionAt: leadDate,
        }).returning({ id: recoveryLeads.id })

        if (cleanPhone) rememberPhoneLeadLookup(leadMap, ambiguousLeadKeys, scope.company.id, cleanPhone, newLead.id)
        if (email) rememberUniqueLeadLookup(leadMap, ambiguousLeadKeys, contactExactKey(scope.company.id, email), newLead.id)
        leadsCreated++
        insertedFromScope++
      }
      if (insertedFromScope > 0 || attributedFromScope > 0) {
        details.push(`${scope.company.name}: ${insertedFromScope} leads de CRM importados e ${attributedFromScope} origens nativas atualizadas.`)
      }
      await crmLeadBatch?.markProcessed()
    } catch (crmErr) {
      details.push(`Aviso ao sincronizar CRM de ${scope.company.name}/${scope.schema}: ${String(crmErr)}`)
    }
  }

  // 6. Sincroniza Referrals de Anúncios Click-to-WhatsApp (CTWA) para cada
  // empresa com agente ativo. A tabela é global, portanto o vínculo seguro é
  // telefone + tenant + proximidade de 72h do primeiro contato; telefone sem
  // company_id (comportamento antigo) contaminava tenants homônimos.
  try {
    const ctwaCompanies = new Map(Array.from(agentScopes.values()).map((scope) => [scope.company.id, scope.company]))
    if (ctwaCompanies.size > 0) {
      const ctwaColumns = await detectAgentsTableColumns('public', 'ctwa_referrals', ['id', 'ts', 'synced_at', 'adset_name'])

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
          ctwaColumns.has('adset_name') ? 'adset_name' : null,
          'ad_name',
          ctwaColumns.has('ts') ? 'ts::text' : null,
          ctwaColumns.has('synced_at') ? 'synced_at::text' : null,
        ].filter((expr): expr is string => !!expr).join(', ')
        const ctwaCursorIdExpr = ctwaColumns.has('id') ? 'id::text' : `concat_ws('|', ${ctwaFallbackIdParts})`
        const ctwaSelectColumns = [
          ctwaColumns.has('id') ? 'id' : null,
          'phone_norm',
          'campaign_name',
          ctwaColumns.has('adset_name') ? 'adset_name' : 'null::text as adset_name',
          'ad_name',
          ctwaColumns.has('ts') ? 'ts' : null,
          ctwaColumns.has('synced_at') ? 'synced_at' : null,
          `${ctwaSortExpr} as __sync_sort_at`,
          `${ctwaCursorIdExpr} as __sync_cursor_id`,
        ].filter((column): column is string => !!column).join(', ')
        for (const company of ctwaCompanies.values()) {
          const ctwaBatch = await loadTimedSyncBatch<CtwaReferralDbRow>({
            companyId: company.id,
            source: 'ctwa_referrals',
            sourceKey: 'public',
            getPosition: ctwaCursorPosition,
            fetchNewRows: (cursor) => queryAgentsDb<CtwaReferralDbRow>(
              `select ${ctwaSelectColumns} from public.ctwa_referrals
               where phone_norm is not null and length(phone_norm) >= 8
                 and (${ctwaSortExpr}, ${ctwaCursorIdExpr}) > ($1::timestamp, $2::text)
               order by ${ctwaSortExpr} asc, ${ctwaCursorIdExpr} asc limit ${SYNC_NEW_BATCH_SIZE}`,
              [cursorTimestampParam(cursor.newestSyncedAt), cursor.newestSyncedId || '']
            ),
            fetchBackfillRows: (cursor) => {
              const hasBackfillCursor = !!cursor.backfillBeforeAt
              return queryAgentsDb<CtwaReferralDbRow>(
                `select ${ctwaSelectColumns} from public.ctwa_referrals
                 where phone_norm is not null and length(phone_norm) >= 8
                 ${hasBackfillCursor ? `and (${ctwaSortExpr}, ${ctwaCursorIdExpr}) < ($1::timestamp, $2::text)` : ''}
                 order by ${ctwaSortExpr} desc, ${ctwaCursorIdExpr} desc limit ${SYNC_BACKFILL_BATCH_SIZE}`,
                hasBackfillCursor ? [cursorTimestampParam(cursor.backfillBeforeAt), cursor.backfillBeforeId || ''] : []
              )
            },
          })

          let ctwaCount = 0
          for (const r of ctwaBatch?.rows || []) {
            const norm = normalizeDigits(r.phone_norm)
            const referralAt = parseCursorDate(r.__sync_sort_at) || ctwaTsToDate(r.ts) || parseCursorDate(r.synced_at)
            if (!norm || !referralAt) continue
            const referralWindowStart = new Date(referralAt.getTime() - 72 * 60 * 60 * 1000)
            const referralWindowEnd = new Date(referralAt.getTime() + 72 * 60 * 60 * 1000)

            const updated = await db.update(recoveryLeads).set({
              trackingSource: 'meta_ads',
              utmCampaign: r.campaign_name || undefined,
              adsetName: r.adset_name || undefined,
              adName: r.ad_name || undefined,
              updatedAt: new Date(),
            }).where(and(
              eq(recoveryLeads.companyId, company.id),
              sql`right(regexp_replace(${recoveryLeads.phone}, '[^0-9]', '', 'g'), 9) = right(${norm}, 9)`,
              sql`coalesce(${recoveryLeads.firstContactAt}, ${recoveryLeads.createdAt}) between ${referralWindowStart.toISOString()}::timestamp and ${referralWindowEnd.toISOString()}::timestamp`
            )).returning({ id: recoveryLeads.id })

            if (updated.length > 0) ctwaCount += updated.length
          }
          if (ctwaCount > 0) {
            details.push(`${company.name}: ${ctwaCount} leads identificados como Anúncios Meta (janela de 72h).`)
          }
          await ctwaBatch?.markProcessed()
        }
      }
    }
  } catch (ctwaErr) {
    const cause = ctwaErr && typeof ctwaErr === 'object' && 'cause' in ctwaErr
      ? String((ctwaErr as { cause?: unknown }).cause)
      : ''
    details.push(`Aviso ao sincronizar CTWA: ${String(ctwaErr)}${cause ? `; causa: ${cause}` : ''}`)
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
