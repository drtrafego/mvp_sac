import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { inferPipelineStage } from '@/lib/pipeline-stage'
import { followupDayKey } from '@/lib/sac-followup-date'
import { effectivePipelineStageSql } from '@/lib/pipeline-columns-update'

export type SacPendingRuleType = 'retorno_vencido' | 'transbordo_sem_dono' | 'etapa_sem_retorno' | 'proxima_acao_vencida'
export interface EvaluatePendingRulesOptions { companyId: number; leadId?: number; now?: Date }
export interface EvaluatePendingRulesResult {
  retornosVencidosCriados: number; transbordosCriados: number
  etapasSemRetornoCriadas: number; proximasAcoesVencidasCriadas: number; itensEncerrados: number
}
export interface SacRuleLead {
  id: number; followUpDate: Date | null; followUpNote: string | null
  nextActionDueAt: Date | null; nextAction: string | null; commitment: string | null
  humanOwnerMemberId: number | null; sacCaseState: string | null; sacCaseEpisode: number
  pipelineStage: string | null; status: string | null; eventType: string | null
  priority: number | null; botPausedAt: Date | null; updatedAt: string | null
}
export interface SacRuleObservation {
  companyId: number; leadId: number; ruleType: SacPendingRuleType; active: boolean
  fingerprint: string | null; reason: string; ownerId: number | null; dueAt: Date | null
  leadUpdatedAt: string | null; now: Date
}
export interface SacPendingRuleStore {
  loadPolicy(companyId: number): Promise<string[]>
  loadLeads(companyId: number, leadId?: number): Promise<SacRuleLead[]>
  reconcile(observation: SacRuleObservation): Promise<{ created: number; closed: number }>
  reconcileMany?(observations: SacRuleObservation[]): Promise<EvaluatePendingRulesResult>
}
export interface SacSqlExecutor { execute(query: SQL): Promise<unknown> }

export function sacSqlRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray(result.rows)) {
    return result.rows as Record<string, unknown>[]
  }
  throw new Error('Resposta inesperada do banco ao reconciliar SAC')
}
// PostgreSQL timestamp-without-time-zone values in this schema are stored in UTC.
// Raw execute() does not apply the ORM column mapper; never interpret them in the host's TZ.
const dateOrNull = (value: unknown): Date | null => {
  if (value == null) return null
  if (value instanceof Date) return value
  const raw = String(value)
  return new Date(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw)
}

/** Batched single statement, supported by Neon HTTP; locks lead snapshots with
 * full PostgreSQL microseconds and reconciles every selected rule atomically. */
export function sacRulesReconciliationSql(observations: SacRuleObservation[]): SQL {
  const inputs = JSON.stringify(observations.map(o => ({
    company_id: o.companyId, lead_id: o.leadId, rule_type: o.ruleType, active: o.active,
    fingerprint: o.fingerprint, reason: o.reason, owner_id: o.ownerId,
    due_at: o.dueAt?.toISOString() ?? null, lead_updated_at: o.leadUpdatedAt, now_at: o.now.toISOString(),
  })))
  return sql`
    WITH inputs AS (
      SELECT * FROM jsonb_to_recordset(${inputs}::jsonb) AS input(
        company_id integer, lead_id integer, rule_type text, active boolean, fingerprint text,
        reason text, owner_id integer, due_at timestamp, lead_updated_at timestamp, now_at timestamp
      )
    ), live_leads AS (
      SELECT lead.company_id, lead.id AS lead_id FROM recovery_leads AS lead
      WHERE EXISTS (SELECT 1 FROM inputs i WHERE i.company_id=lead.company_id AND i.lead_id=lead.id
        AND i.lead_updated_at IS NOT DISTINCT FROM lead.updated_at)
      ORDER BY lead.company_id,lead.id FOR UPDATE OF lead
    ), observation AS (
      INSERT INTO sac_rule_states (company_id, lead_id, rule_type, active, fingerprint, occurrence_number, updated_at)
      SELECT i.company_id,i.lead_id,i.rule_type,i.active,i.fingerprint,CASE WHEN i.active THEN 1 ELSE 0 END,i.now_at
      FROM inputs i JOIN live_leads l USING (company_id,lead_id)
      ON CONFLICT (company_id, lead_id, rule_type) DO UPDATE SET
        occurrence_number = CASE
          WHEN EXCLUDED.active AND (NOT sac_rule_states.active OR sac_rule_states.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint)
          THEN sac_rule_states.occurrence_number + 1 ELSE sac_rule_states.occurrence_number END,
        active = EXCLUDED.active, fingerprint = EXCLUDED.fingerprint, updated_at = EXCLUDED.updated_at
      RETURNING company_id,lead_id,rule_type,active,occurrence_number,updated_at
    ), closed AS (
      UPDATE sac_pending_items p SET state='resolvido',resolved_at=o.updated_at
      FROM observation o WHERE p.company_id=o.company_id AND p.lead_id=o.lead_id AND p.rule_type=o.rule_type
        AND p.state IN ('pendente','em_atendimento')
        AND (NOT o.active OR p.source_key <> 'episode:' || o.occurrence_number::text)
      RETURNING p.id,p.company_id,p.lead_id,p.rule_type,p.resolved_at
    ), inserted AS (
      INSERT INTO sac_pending_items
        (company_id,lead_id,rule_type,source_key,reason,human_owner_member_id,due_at,state,created_at)
      SELECT o.company_id,o.lead_id,o.rule_type,'episode:' || o.occurrence_number::text,
        i.reason,i.owner_id,i.due_at,'pendente',i.now_at
      FROM observation o JOIN inputs i USING (company_id,lead_id,rule_type) WHERE o.active
      ON CONFLICT (company_id,lead_id,rule_type,source_key) DO NOTHING
      RETURNING id,company_id,lead_id,rule_type,created_at
    ), refreshed AS (
      UPDATE sac_pending_items p SET reason=i.reason,human_owner_member_id=i.owner_id,due_at=i.due_at
      FROM observation o JOIN inputs i USING (company_id,lead_id,rule_type)
      WHERE p.company_id=o.company_id AND p.lead_id=o.lead_id AND p.rule_type=o.rule_type
        AND p.state IN ('pendente','em_atendimento') AND o.active
        AND p.source_key='episode:' || o.occurrence_number::text
      RETURNING p.id
    ), audited AS (
      INSERT INTO sac_audit_events (company_id,lead_id,type,actor_type,reference_type,reference_id,occurred_at)
      SELECT company_id,lead_id,'pending_rule_triggered','system','pending_item',id::text,created_at FROM inserted
      UNION ALL
      SELECT company_id,lead_id,'pending_rule_resolved','system','pending_item',id::text,resolved_at FROM closed
      RETURNING id
    )
    SELECT (SELECT count(*)::integer FROM inserted) AS created,
      (SELECT count(*)::integer FROM closed) AS closed,
      (SELECT count(*)::integer FROM inserted WHERE rule_type='retorno_vencido') AS "retornosVencidosCriados",
      (SELECT count(*)::integer FROM inserted WHERE rule_type='transbordo_sem_dono') AS "transbordosCriados",
      (SELECT count(*)::integer FROM inserted WHERE rule_type='etapa_sem_retorno') AS "etapasSemRetornoCriadas",
      (SELECT count(*)::integer FROM inserted WHERE rule_type='proxima_acao_vencida') AS "proximasAcoesVencidasCriadas"
  `
}
export function sacRuleReconciliationSql(observation: SacRuleObservation): SQL {
  return sacRulesReconciliationSql([observation])
}

export function createSacPendingRuleStore(database: SacSqlExecutor): SacPendingRuleStore {
  return {
    async loadPolicy(companyId) {
      const [row] = sacSqlRows(await database.execute(sql`
        SELECT sac_followup_stage_ids AS stages, pipeline_columns AS columns FROM settings WHERE company_id = ${companyId}
      `))
      const allowedStages = Array.isArray(row?.columns)
        ? new Set(row.columns.flatMap(c => c && typeof c === 'object' && 'id' in c ? [String(c.id)] : []))
        : new Set(['novo_contato', 'em_atendimento', 'qualificado', 'agendado', 'compareceu', 'fechado', 'perdido'])
      return Array.isArray(row?.stages) ? row.stages.filter((s): s is string => typeof s === 'string' && allowedStages.has(s)) : []
    },
    async loadLeads(companyId, leadId) {
      const rows = sacSqlRows(await database.execute(sql`
        SELECT id, follow_up_date, follow_up_note, next_action_due_at, next_action, commitment,
          human_owner_member_id, sac_case_state, sac_case_episode,
          pipeline_stage, status, event_type, priority, bot_paused_at, updated_at::text AS updated_at
        FROM recovery_leads WHERE company_id = ${companyId} ${leadId === undefined ? sql`` : sql`AND id = ${leadId}`}
          AND (
            (sac_case_state IS DISTINCT FROM 'resolvido' AND follow_up_date IS NOT NULL)
            OR (sac_case_state IS DISTINCT FROM 'resolvido' AND next_action_due_at IS NOT NULL)
            OR sac_case_state='transbordo'
            OR (sac_case_state IS DISTINCT FROM 'resolvido' AND EXISTS (
              SELECT 1 FROM settings s WHERE s.company_id=recovery_leads.company_id
                AND s.sac_followup_stage_ids ? ${effectivePipelineStageSql()}
            ))
            OR EXISTS (SELECT 1 FROM sac_rule_states r WHERE r.company_id=recovery_leads.company_id AND r.lead_id=recovery_leads.id AND r.active)
            OR EXISTS (SELECT 1 FROM sac_pending_items p WHERE p.company_id=recovery_leads.company_id AND p.lead_id=recovery_leads.id AND p.state IN ('pendente','em_atendimento'))
          )
      `))
      return rows.map(row => ({
        id: Number(row.id), followUpDate: dateOrNull(row.follow_up_date), followUpNote: row.follow_up_note as string | null,
        nextActionDueAt: dateOrNull(row.next_action_due_at), nextAction: row.next_action as string | null,
        commitment: row.commitment as string | null,
        humanOwnerMemberId: row.human_owner_member_id == null ? null : Number(row.human_owner_member_id),
        sacCaseState: row.sac_case_state as string | null, sacCaseEpisode: Number(row.sac_case_episode ?? 1),
        pipelineStage: row.pipeline_stage as string | null, status: row.status as string | null,
        eventType: row.event_type as string | null, priority: row.priority == null ? null : Number(row.priority),
        botPausedAt: dateOrNull(row.bot_paused_at), updatedAt: row.updated_at == null ? null : String(row.updated_at),
      }))
    },
    async reconcile(observation) {
      const [result] = sacSqlRows(await database.execute(sacRuleReconciliationSql(observation)))
      return { created: Number(result.created), closed: Number(result.closed) }
    },
    async reconcileMany(observations) {
      const [result] = sacSqlRows(await database.execute(sacRulesReconciliationSql(observations)))
      return {
        retornosVencidosCriados: Number(result.retornosVencidosCriados), transbordosCriados: Number(result.transbordosCriados),
        etapasSemRetornoCriadas: Number(result.etapasSemRetornoCriadas),
        proximasAcoesVencidasCriadas: Number(result.proximasAcoesVencidasCriadas), itensEncerrados: Number(result.closed),
      }
    },
  }
}

export async function evaluateSacPendingRules(
  options: EvaluatePendingRulesOptions,
  store: SacPendingRuleStore = createSacPendingRuleStore(db),
): Promise<EvaluatePendingRulesResult> {
  const now = options.now ?? new Date()
  const today = followupDayKey(now)!
  const requiredStages = new Set(await store.loadPolicy(options.companyId))
  const leads = await store.loadLeads(options.companyId, options.leadId)
  const result = { retornosVencidosCriados: 0, transbordosCriados: 0, etapasSemRetornoCriadas: 0, proximasAcoesVencidasCriadas: 0, itensEncerrados: 0 }
  const batch: SacRuleObservation[] = []

  for (const lead of leads) {
    const open = lead.sacCaseState !== 'resolvido'
    const returnDay = followupDayKey(lead.followUpDate)
    const actionDay = followupDayKey(lead.nextActionDueAt)
    const stage = inferPipelineStage(lead)
    const episode = lead.sacCaseEpisode
    const observations: Array<Omit<SacRuleObservation, 'companyId' | 'leadId' | 'leadUpdatedAt' | 'now'>> = [
      {
        ruleType: 'proxima_acao_vencida', active: open && actionDay !== null && actionDay < today,
        fingerprint: lead.nextActionDueAt ? `${episode}:${lead.nextActionDueAt.toISOString()}` : null,
        reason: `Prazo da próxima ação (${actionDay ?? 'data não informada'}) está vencido.${lead.nextAction?.trim() ? ` Ação: ${lead.nextAction.trim()}` : lead.commitment?.trim() ? ` Compromisso: ${lead.commitment.trim()}` : ''}`,
        ownerId: lead.humanOwnerMemberId, dueAt: lead.nextActionDueAt,
      },
      {
        ruleType: 'retorno_vencido', active: open && returnDay !== null && returnDay < today,
        fingerprint: lead.followUpDate ? `${episode}:${lead.followUpDate.toISOString()}` : null,
        reason: `Retorno agendado para ${returnDay ?? 'data não informada'} está vencido.${lead.followUpNote ? ` Motivo: ${lead.followUpNote}` : ''}`,
        ownerId: lead.humanOwnerMemberId, dueAt: lead.followUpDate,
      },
      {
        ruleType: 'transbordo_sem_dono', active: lead.sacCaseState === 'transbordo' && lead.humanOwnerMemberId === null,
        fingerprint: `${episode}:transbordo`, reason: 'Solicitação de atendimento humano aguardando um responsável na equipe.',
        ownerId: null, dueAt: lead.botPausedAt,
      },
      {
        ruleType: 'etapa_sem_retorno', active: open && lead.followUpDate === null && requiredStages.has(stage),
        fingerprint: `${episode}:${stage}`, reason: `Lead na etapa '${stage}' sem retorno agendado. Sugestão: programar acompanhamento.`,
        ownerId: lead.humanOwnerMemberId, dueAt: null,
      },
    ]
    for (const observation of observations) {
      const input = { ...observation, companyId: options.companyId, leadId: lead.id, leadUpdatedAt: lead.updatedAt, now }
      if (store.reconcileMany) { batch.push(input); continue }
      const reconciled = await store.reconcile(input)
      const key = observation.ruleType === 'retorno_vencido' ? 'retornosVencidosCriados'
        : observation.ruleType === 'transbordo_sem_dono' ? 'transbordosCriados'
        : observation.ruleType === 'proxima_acao_vencida' ? 'proximasAcoesVencidasCriadas' : 'etapasSemRetornoCriadas'
      result[key] += reconciled.created
      result.itensEncerrados += reconciled.closed
    }
  }
  if (store.reconcileMany) {
    for (let offset=0;offset<batch.length;offset+=498) {
      const reconciled=await store.reconcileMany(batch.slice(offset,offset+498))
      for (const key of Object.keys(result) as Array<keyof EvaluatePendingRulesResult>) result[key]+=reconciled[key]
    }
  }
  return result
}
