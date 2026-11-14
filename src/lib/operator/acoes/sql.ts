import { sql, type SQL } from 'drizzle-orm'
import type { Ator, PreparedAction } from './types'

export function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const e = error as { code?: string; cause?: unknown }
  return e.code ?? postgresCode(e.cause)
}
export function gate(ator: Ator, a: PreparedAction) {
  const permission = a.actionType.replace(/^desfazer_/, '')
  return sql`SELECT 1 FROM sac_operator_company_settings s
    JOIN sac_operator_jobs j ON j.company_id = s.company_id
    JOIN sac_operator_actions a ON a.company_id = s.company_id AND a.job_id = j.id
    WHERE s.company_id = ${ator.companyId} AND s.enabled AND NOT s.kill_switch AND s.allowed_actions ? ${permission}
      AND j.id = ${a.jobId}::uuid AND j.status = 'em_execucao'
      AND a.id = ${a.id}::uuid AND a.status IN ('pendente', 'aguardando_confirmacao')`
}
function audit(ator: Ator, a: PreparedAction, type: string, payload: SQL) {
  return sql`INSERT INTO sac_audit_events (company_id, lead_id, type, actor_type, actor_id, actor_name, reference_type, reference_id, payload)
    SELECT ${ator.companyId}, ${a.requestJson.leadId}, ${type}, 'human', ${ator.userId}, ${ator.actorName},
      ${type === 'context_updated' ? 'sac_operator_actions' : 'sac_internal_notes'},
      ${type === 'context_updated' ? sql`${a.id}` : sql`eff.id::text`}, ${payload} FROM eff RETURNING id`
}
function finish(ator: Ator, a: PreparedAction, effect: SQL, after: SQL, type: string, payload: SQL) {
  return sql`WITH gate AS (${gate(ator, a)}), eff AS (${effect}), rec AS (
    UPDATE sac_operator_actions SET status = 'concluido', after_snapshot = ${after}, applied_at = now()
    FROM eff WHERE sac_operator_actions.id = ${a.id}::uuid AND company_id = ${ator.companyId}
      AND status IN ('pendente', 'aguardando_confirmacao') RETURNING sac_operator_actions.id
  ), aud AS (${audit(ator, a, type, payload)}), chk AS (
    SELECT 1 / CASE WHEN (SELECT count(*) FROM eff) = (SELECT count(*) FROM rec)
      AND (SELECT count(*) FROM eff) = (SELECT count(*) FROM aud) THEN 1 ELSE 0 END AS ok
  ) SELECT (SELECT count(*) FROM eff)::int AS efeitos, (SELECT count(*) FROM gate)::int AS gates, ok FROM chk`
}
export function efeitoSql(ator: Ator, a: PreparedAction, noteId?: number) {
  const r = a.requestJson
  const before = a.beforeSnapshot!
  const base = sql`jsonb_build_object('origem', 'operador_sac', 'jobId', ${a.jobId}::text)`
  if (a.actionType === 'mover_etapa' || a.actionType === 'desfazer_mover_etapa') {
    const effect = sql`UPDATE recovery_leads SET pipeline_stage = ${r.etapaId}, updated_at = now(),
      last_action_by = ${ator.actorName + ' (Operador SAC)'}, last_action_at = now(), context_version = coalesce(context_version, 1) + 1
      FROM gate WHERE id = ${r.leadId} AND company_id = ${ator.companyId}
        AND pipeline_stage IS NOT DISTINCT FROM ${before.pipelineStage}::text AND coalesce(context_version, 1) = ${before.contextVersion}
      RETURNING id, pipeline_stage, context_version`
    return finish(ator, a, effect, sql`jsonb_build_object('pipelineStage', eff.pipeline_stage, 'contextVersion', eff.context_version)`, 'context_updated',
      sql`${base} || jsonb_build_object('updatedFields', jsonb_build_array('pipelineStage'), 'de', ${before.pipelineStage}::text, 'para', ${r.etapaId}::text)`)
  }
  if (a.actionType === 'anotar_lead') {
    return sql`WITH gate AS (${gate(ator, a)}), clm AS (
      UPDATE sac_operator_actions SET status = 'concluido', after_snapshot = jsonb_build_object('noteId', ${noteId}::int), applied_at = now()
      WHERE id = ${a.id}::uuid AND company_id = ${ator.companyId} AND status IN ('pendente', 'aguardando_confirmacao')
        AND EXISTS (SELECT 1 FROM gate) AND EXISTS (SELECT 1 FROM recovery_leads WHERE id = ${r.leadId} AND company_id = ${ator.companyId}) RETURNING id
    ), eff AS (
      INSERT INTO sac_internal_notes (id, company_id, lead_id, author_type, author_id, author_name, body, created_at, updated_at)
      SELECT ${noteId}, ${ator.companyId}, ${r.leadId}, 'human', ${ator.userId}, ${ator.actorName}, ${r.texto}, now(), now() FROM clm RETURNING id
    ), aud AS (${audit(ator, a, 'internal_note_added', sql`${base} || jsonb_build_object('noteId', eff.id, 'preview', ${r.texto!.slice(0, 80)}::text)`)}), chk AS (
      SELECT 1 / CASE WHEN (SELECT count(*) FROM clm) = (SELECT count(*) FROM eff)
        AND (SELECT count(*) FROM eff) = (SELECT count(*) FROM aud) THEN 1 ELSE 0 END AS ok
    ) SELECT (SELECT count(*) FROM eff)::int AS efeitos, (SELECT count(*) FROM gate)::int AS gates, ok FROM chk`
  }
  if (a.actionType === 'desfazer_anotar_lead') {
    return finish(ator, a, sql`UPDATE sac_internal_notes SET deleted_at = now(), updated_at = now() FROM gate
      WHERE id = ${r.noteId} AND company_id = ${ator.companyId} AND lead_id = ${r.leadId} AND deleted_at IS NULL RETURNING id`,
    sql`jsonb_build_object('noteId', eff.id)`, 'internal_note_deleted', sql`${base} || jsonb_build_object('noteId', eff.id)`)
  }
  throw new Error('Ação sem executor nesta fatia.')
}
