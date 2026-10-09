import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { followupDayKey } from '@/lib/sac-followup-date'
import { sacSqlRows, type SacSqlExecutor } from '@/lib/sac-pending-rules'
import { ATTENTION_VIEWS, type AttentionQuery, type AttentionResponse, type AttentionView } from '@/lib/sac-attention-types'

export class AttentionInputError extends Error {
  readonly status = 400
}

export function parseAttentionQuery(params: URLSearchParams): AttentionQuery {
  const view = params.get('view') ?? 'all'
  if (!ATTENTION_VIEWS.includes(view as AttentionView)) throw new AttentionInputError('Filtro de atendimento inválido.')
  const positiveInteger = (name: string, fallback: number, maximum: number) => {
    const raw = params.get(name)
    if (raw === null) return fallback
    if (!/^[1-9]\d*$/.test(raw)) throw new AttentionInputError(`${name} deve ser um inteiro positivo.`)
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value > maximum) throw new AttentionInputError(`${name} excede o limite permitido (${maximum}).`)
    return value
  }
  return { view: view as AttentionView, page: positiveInteger('page', 1, 100_000), pageSize: positiveInteger('pageSize', 25, 100) }
}

export interface LoadAttentionOptions extends AttentionQuery {
  companyId: number
  userId: string
  now?: Date
}

/** One SQL snapshot for counters and the selected page; no per-conversation requests.
 * Dates in recovery_leads are UTC timestamp-without-time-zone. The card edits a
 * calendar day, so its deadline expires only on the following São Paulo day.
 * A handoff's bot_paused_at is not a deadline and must never appear as dueAt.
 */
export function sacAttentionSql(options: LoadAttentionOptions): SQL {
  const today = followupDayKey(options.now ?? new Date())!
  const filters: Record<AttentionView, SQL> = {
    all: sql`true`, human: sql`is_human`, unassigned: sql`human_owner_member_id IS NULL`,
    overdue: sql`overdue`, today: sql`is_today`,
    mine: sql`human_owner_member_id = (SELECT id FROM current_member)`,
  }
  return sql`
    WITH current_member AS (
      SELECT id FROM company_members WHERE company_id=${options.companyId}
        AND stack_auth_user_id=${options.userId} AND status='ativo' ORDER BY id LIMIT 1
    ), active_pending AS (
      SELECT p.lead_id, jsonb_agg(p.reason ORDER BY p.created_at,p.id) AS pending_reasons
      FROM sac_pending_items p WHERE p.company_id=${options.companyId}
        AND p.state IN ('pendente','em_atendimento') GROUP BY p.lead_id
    ), candidates AS (
      SELECT l.id AS lead_id,l.name,l.phone,l.channel,l.request_summary,l.next_action,
        l.next_action_due_at,l.follow_up_date,
        least(l.next_action_due_at,l.follow_up_date) AS due_at,
        l.human_owner_member_id,
        coalesce(nullif(trim(m.name),''),m.email) AS human_owner_name,
        l.sac_case_state,coalesce(l.sac_case_state IN ('transbordo','em_atendimento'),false) AS is_human,
        coalesce(p.pending_reasons,'[]'::jsonb) AS pending_reasons
      FROM recovery_leads l
      LEFT JOIN company_members m ON m.id=l.human_owner_member_id AND m.company_id=l.company_id AND m.status='ativo'
      LEFT JOIN active_pending p ON p.lead_id=l.id
      WHERE l.company_id=${options.companyId} AND l.sac_case_state IS DISTINCT FROM 'resolvido'
        AND (l.sac_case_state IN ('transbordo','em_atendimento')
          OR nullif(trim(l.next_action),'') IS NOT NULL OR l.next_action_due_at IS NOT NULL
          OR l.follow_up_date IS NOT NULL OR p.lead_id IS NOT NULL)
    ), attention AS (
      SELECT *,coalesce((due_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date < ${today}::date,false) AS overdue,
        coalesce((due_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date = ${today}::date,false) AS is_today,
        coalesce((next_action_due_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date < ${today}::date,false) AS action_overdue,
        coalesce((follow_up_date AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::date < ${today}::date,false) AS return_overdue
      FROM candidates
    ), filtered AS (
      SELECT * FROM attention WHERE ${filters[options.view]}
    ), ranked AS (
      SELECT *,CASE WHEN overdue THEN 0 WHEN is_human AND human_owner_member_id IS NULL THEN 1
        WHEN is_today THEN 2 WHEN is_human THEN 3 ELSE 4 END AS urgency FROM filtered
    ), picked AS (
      SELECT * FROM ranked ORDER BY urgency,due_at ASC NULLS LAST,lead_id
        LIMIT ${options.pageSize} OFFSET ${(options.page - 1) * options.pageSize}
    )
    SELECT (SELECT id FROM current_member) AS "currentMemberId",
      (SELECT count(*)::integer FROM filtered) AS total,
      jsonb_build_object(
        'all',(SELECT count(*)::integer FROM attention),
        'human',(SELECT count(*)::integer FROM attention WHERE is_human),
        'unassigned',(SELECT count(*)::integer FROM attention WHERE human_owner_member_id IS NULL),
        'overdue',(SELECT count(*)::integer FROM attention WHERE overdue),
        'today',(SELECT count(*)::integer FROM attention WHERE is_today),
        'mine',(SELECT count(*)::integer FROM attention WHERE human_owner_member_id=(SELECT id FROM current_member))
      ) AS counts,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'leadId',lead_id,'name',name,'phone',phone,'channel',channel,'requestSummary',request_summary,
        'nextAction',next_action,'dueAt',to_char(due_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'humanOwnerMemberId',human_owner_member_id,'humanOwnerName',human_owner_name,
        'sacCaseState',sac_case_state,'overdue',overdue,
        'reasons',pending_reasons
          || CASE WHEN action_overdue THEN jsonb_build_array('Prazo da próxima ação vencido') ELSE '[]'::jsonb END
          || CASE WHEN return_overdue THEN jsonb_build_array('Retorno agendado vencido') ELSE '[]'::jsonb END
          || CASE WHEN sac_case_state='transbordo' THEN jsonb_build_array('Aguardando atendimento humano') ELSE '[]'::jsonb END
          || CASE WHEN sac_case_state='em_atendimento' THEN jsonb_build_array('Atendimento humano em andamento') ELSE '[]'::jsonb END
          || CASE WHEN NOT overdue AND due_at IS NOT NULL THEN jsonb_build_array('Ação ou retorno com prazo registrado') ELSE '[]'::jsonb END
          || CASE WHEN due_at IS NULL AND nullif(trim(next_action),'') IS NOT NULL THEN jsonb_build_array('Próxima ação sem prazo') ELSE '[]'::jsonb END
      ) ORDER BY urgency,due_at ASC NULLS LAST,lead_id) FROM picked),'[]'::jsonb) AS items
  `
}

export async function loadSacAttention(options: LoadAttentionOptions, database: SacSqlExecutor = db): Promise<AttentionResponse> {
  const now = options.now ?? new Date()
  // Validate even when this helper is called directly by a server component.
  const query = parseAttentionQuery(new URLSearchParams({ view: options.view, page: String(options.page), pageSize: String(options.pageSize) }))
  const [row] = sacSqlRows(await database.execute(sacAttentionSql({ ...options, ...query, now })))
  if (!row) throw new Error('Resposta inesperada ao carregar a fila de atendimento.')
  const counts = row.counts as AttentionResponse['counts']
  const items = row.items as AttentionResponse['items']
  return {
    items: items.map(item => ({ ...item, reasons: [...new Set(item.reasons)] })), counts,
    ...query, total: Number(row.total), hasMore: query.page * query.pageSize < Number(row.total),
    currentMemberId: row.currentMemberId == null ? null : Number(row.currentMemberId), now: now.toISOString(),
  }
}
