import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'

export type AutomationType = 'comment' | 'story'
export type ReportType = AutomationType | 'all'
export type DeliveryStatus = 'sent' | 'failed' | 'skipped' | 'observed' | 'reserved' | 'unknown'
export interface ReportPeriod { from: string; to: string }
export class ReportParameterError extends Error {}
const DAY = 86_400_000

function parseDate(value: string, field: string): number {
  // Exige data civil real e fuso explícito quando há horário. Date.parse sozinho
  // aceita 30 de fevereiro e horários locais, que variam conforme o servidor.
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(value)
  const time = Date.parse(value)
  const civil = match ? new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`) : null
  const supportedYear = time >= Date.parse('0001-01-01T00:00:00Z') && time <= Date.parse('9999-12-31T23:59:59.999Z')
  if (!match || !Number.isFinite(time) || !supportedYear || !civil || civil.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new ReportParameterError(`${field} deve ser uma data válida YYYY-MM-DD ou ISO 8601 com fuso horário.`)
  }
  return time
}

export function reportPeriod(params: URLSearchParams, now = Date.now()): ReportPeriod {
  const to = params.has('to') ? parseDate(params.get('to')!, 'to') : now
  const from = params.has('from') ? parseDate(params.get('from')!, 'from') : to - 30 * DAY
  if (from > to) throw new ReportParameterError('from não pode ser posterior a to.')
  if (to - from > 366 * DAY) throw new ReportParameterError('O intervalo máximo é de 366 dias.')
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() }
}

export function reportType(value: string): ReportType {
  if (value !== 'comment' && value !== 'story' && value !== 'all') {
    throw new ReportParameterError('type deve ser comment, story ou all.')
  }
  return value
}

export function positiveInteger(value: string, field: string, max = 2_147_483_647): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    throw new ReportParameterError(`${field} deve ser um inteiro entre 1 e ${max}.`)
  }
  return Number(value)
}

function rows<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : (result as { rows?: T[] }).rows ?? []) as T[]
}

// Mesmo critério do painel de comentários: só 'sent' é enviado e só
// 'failed' é falha. Story já persiste os seis status canônicos. Não há
// agregador compartilhado no painel; estas expressões reutilizam os critérios
// existentes, sem alterar suas rotas nem usar total_triggered (sem período).
function normalizedStatus(): SQL {
  return sql`CASE
    WHEN status IN ('sent', 'failed', 'observed', 'reserved') THEN status
    WHEN status IN ('skipped', 'rate_limited', 'ignorado_pausa') THEN 'skipped'
    WHEN status = 'processing' THEN 'reserved'
    ELSE 'unknown' END`
}

function logSource(type: AutomationType, companyId: number, period: ReportPeriod): SQL {
  // Identificadores SQL são constantes internas, nunca parâmetros do cliente.
  const table = sql.identifier(type === 'comment' ? 'instagram_comment_logs' : 'instagram_story_deliveries')
  const timestamp = type === 'comment' ? sql`created_at AT TIME ZONE 'UTC'` : sql`created_at`
  return sql`SELECT id, automation_id, ${type}::text AS type, ${normalizedStatus()} AS status,
    ${timestamp} AS activated_at FROM ${table}
    WHERE company_id = ${companyId}
      AND ${timestamp} >= ${period.from}::timestamptz AND ${timestamp} <= ${period.to}::timestamptz`
}

function ruleSource(type: AutomationType, companyId: number): SQL {
  if (type === 'comment') return sql`SELECT id, 'comment'::text AS type, name,
    CASE WHEN keywords IS NULL OR btrim(keywords) = '' THEN ARRAY[]::text[]
      ELSE regexp_split_to_array(btrim(keywords), '[[:space:]]*,[[:space:]]*') END AS keywords,
    match_type, trigger_type, media_id AS target_id, coalesce(is_active, false) AS is_active, NULL::text AS mode
    FROM instagram_comment_automations WHERE company_id = ${companyId}`
  return sql`SELECT id, 'story'::text AS type, name, keywords, match_type,
    'story_reply'::text AS trigger_type, story_id AS target_id, is_active, mode
    FROM instagram_story_automations WHERE company_id = ${companyId}`
}

export interface Totals {
  disparos: number; enviados: number; falhas: number; ignorados: number
  observados: number; reservados: number; desconhecidos: number
  ultimoDisparo: string | null
  visualizou: null; clicou: null
  disponivel: { visualizou: false; clicou: false }
}
function emptyTotals(): Totals {
  return { disparos: 0, enviados: 0, falhas: 0, ignorados: 0, observados: 0,
    reservados: 0, desconhecidos: 0, ultimoDisparo: null,
    visualizou: null, clicou: null, disponivel: { visualizou: false, clicou: false } }
}
function iso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString()
}
interface CountRow {
  type: AutomationType; automation_id: number | null; status: DeliveryStatus
  total: string | number; last_at: string | Date | null
}
function addCount(totals: Totals, row: CountRow) {
  const fields = { sent: 'enviados', failed: 'falhas', skipped: 'ignorados', observed: 'observados', reserved: 'reservados', unknown: 'desconhecidos' } as const
  const total = Number(row.total)
  totals.disparos += total
  totals[fields[row.status]] += total
  const last = iso(row.last_at)
  if (last && (!totals.ultimoDisparo || last > totals.ultimoDisparo)) totals.ultimoDisparo = last
}
interface RuleRow {
  id: number; type: AutomationType; name: string; keywords: string[]
  match_type: string; trigger_type: string; target_id: string | null; is_active: boolean; mode: string | null
}

export async function automationMetrics(companyId: number, type: ReportType, period: ReportPeriod) {
  const types: AutomationType[] = type === 'all' ? ['comment', 'story'] : [type]
  // Uma única instrução: regras e contagens usam o mesmo snapshot de leitura.
  const result = rows<{ rules: RuleRow[]; counts: CountRow[] }>(await db.execute(sql`
    WITH rules AS (${sql.join(types.map(t => ruleSource(t, companyId)), sql` UNION ALL `)}),
      logs AS (${sql.join(types.map(t => logSource(t, companyId, period)), sql` UNION ALL `)}),
      counts AS (SELECT type, automation_id, status, count(*) AS total, max(activated_at) AS last_at
        FROM logs GROUP BY type, automation_id, status)
    SELECT coalesce((SELECT jsonb_agg(r ORDER BY r.type, r.id) FROM rules r), '[]'::jsonb) AS rules,
      coalesce((SELECT jsonb_agg(c) FROM counts c), '[]'::jsonb) AS counts
  `))[0]
  const totais = emptyTotals()
  const porTipo = { comment: emptyTotals(), story: emptyTotals() }
  const byRule = new Map<string, Totals>()
  for (const row of result.counts) {
    addCount(totais, row)
    addCount(porTipo[row.type], row)
    const key = `${row.type}:${row.automation_id}`
    const counts = byRule.get(key) ?? emptyTotals()
    addCount(counts, row)
    byRule.set(key, counts)
  }
  return { period, type, totais, porTipo, automations: result.rules.map(rule => ({
    type: rule.type, id: rule.id, name: rule.name, keywords: rule.keywords,
    matchType: rule.match_type, triggerType: rule.trigger_type, targetId: rule.target_id,
    isActive: rule.is_active, mode: rule.mode,
    totais: byRule.get(`${rule.type}:${rule.id}`) ?? emptyTotals(),
  })) }
}

export function maskedSender(value: string): string | null {
  // Entradas manuais podem conter 'manual:<comment_id>'; não expor esse valor.
  return /^\d+$/.test(value) ? `****${value.slice(-4)}` : null
}

function safeReason(status: DeliveryStatus, rawStatus: string, rawReason: string | null): string | null {
  // Erros da Graph API podem incluir IDs, tokens ou conteúdo do usuário.
  // Expor apenas diagnóstico categorizado, nunca a mensagem bruta.
  const knownReasons = new Set([
    'Resposta anterior à ativação da regra.',
    'Fora da janela de 24 horas.',
    'Lead não encontrado para releitura da pausa.',
    'Modo teste: nenhum Direct foi enviado.',
    'Comentário já respondido manualmente antes da ativação da automação.',
  ])
  if (rawReason && knownReasons.has(rawReason)) return rawReason
  if (rawReason?.startsWith('Pausa não contornável:')) return 'Envio ignorado por pausa.'
  if (rawStatus === 'rate_limited') return 'Limite de envios atingido.'
  if (rawStatus === 'ignorado_pausa') return 'Envio ignorado por pausa.'
  const reasons = { sent: null, failed: 'Falha ao enviar a mensagem.', skipped: 'Ativação ignorada.',
    observed: 'Modo teste: nenhum envio realizado.', reserved: 'Envio reservado ou em processamento.', unknown: 'Resultado do envio não confirmado.' }
  return reasons[status]
}
interface LogRow {
  id: number; activated_at: string | Date | null; status: DeliveryStatus; raw_status: string; raw_reason: string | null
  sender_id: string; username: string | null; matched_keyword: string | null; outbound_message_id: string | null
}
export async function automationLogs(companyId: number, type: AutomationType, id: number, period: ReportPeriod, page: number, limit: number) {
  const table = sql.identifier(type === 'comment' ? 'instagram_comment_logs' : 'instagram_story_deliveries')
  const timestamp = type === 'comment' ? sql`created_at AT TIME ZONE 'UTC'` : sql`created_at`
  const fields = type === 'comment'
    ? sql`commenter_id AS sender_id, commenter_username AS username, matched_keyword, NULL::text AS outbound_message_id, error_message AS raw_reason`
    : sql`sender_id, NULL::text AS username, NULL::text AS matched_keyword, outbound_message_id, reason AS raw_reason`
  const result = rows<{ found: boolean; total: string | number; logs: LogRow[] }>(await db.execute(sql`
    WITH rule AS (${ruleSource(type, companyId)}),
      filtered AS (SELECT id, ${timestamp} AS activated_at, ${normalizedStatus()} AS status,
        status AS raw_status, ${fields} FROM ${table}
        WHERE company_id = ${companyId} AND automation_id = ${id}
          AND ${timestamp} >= ${period.from}::timestamptz AND ${timestamp} <= ${period.to}::timestamptz
          AND EXISTS (SELECT 1 FROM rule WHERE id = ${id})),
      paged AS (SELECT * FROM filtered ORDER BY id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit})
    SELECT EXISTS (SELECT 1 FROM rule WHERE id = ${id}) AS found,
      (SELECT count(*) FROM filtered) AS total,
      coalesce((SELECT jsonb_agg(p ORDER BY p.id DESC) FROM paged p), '[]'::jsonb) AS logs
  `))[0]
  if (!result.found) return null
  return { period, type, automationId: id, page, limit, total: Number(result.total),
    logs: result.logs.map(log => ({ id: log.id, createdAt: iso(log.activated_at), status: log.status,
      reason: safeReason(log.status, log.raw_status, log.raw_reason), matchedKeyword: log.matched_keyword,
      senderId: maskedSender(log.sender_id), commenterUsername: log.username,
      outboundMessageId: log.outbound_message_id })) }
}
