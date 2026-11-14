import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { effectivePipelineStageSql } from '@/lib/pipeline-columns-update'
import { gate } from './sql'
import { OperatorServiceError } from '../service'
import type { Ator, PreparedAction } from './types'

export const LOTE_DIRETO_MAX = 20
export const LOTE_ABSOLUTO_MAX = 200
export type BatchDecision = { kind: 'empty' | 'direct' | 'confirmation' | 'refused'; count: number; code: string | null }
export type BatchLead = { id: number; pipelineStage: string | null; contextVersion: number; etapaEfetiva: string; beforePipelineStage?: string | null }
type BatchRequest = { etapaOrigem?: string; etapaDestino?: string; lote?: BatchLead[] }
type BatchSnapshot = { lote?: BatchLead[] }

export function classifyBatch(count: number): BatchDecision {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('O tamanho do lote é inválido.')
  if (count === 0) return { kind: 'empty', count, code: null }
  if (count <= LOTE_DIRETO_MAX) return { kind: 'direct', count, code: null }
  if (count <= LOTE_ABSOLUTO_MAX) return { kind: 'confirmation', count, code: String(count) }
  return { kind: 'refused', count, code: 'BATCH_TOO_LARGE' }
}

export async function completarLote(ator: Ator, action: PreparedAction, aliases: Record<string, string> = {}) {
  void aliases
  const request = action.requestJson as typeof action.requestJson & BatchRequest
  const origem = request.etapaOrigem
  if (!origem) return action
  const rows = await db.execute<{ id: number; pipeline_stage: string | null; context_version: number }>(sql`
    SELECT id, pipeline_stage, coalesce(context_version, 1)::int AS context_version FROM recovery_leads
    WHERE company_id = ${ator.companyId} AND ${effectivePipelineStageSql()} = ${origem} ORDER BY id LIMIT 201`)
  const lote: BatchLead[] = rows.rows.map(row => ({ id: Number(row.id), pipelineStage: row.pipeline_stage, contextVersion: Number(row.context_version), etapaEfetiva: origem }))
  const decision = classifyBatch(lote.length)
  if (decision.kind === 'refused') throw new OperatorServiceError('Esse lote é grande demais. Use o pipeline do painel.', 400, 'BATCH_TOO_LARGE')
  const execucao: 'cartao' | 'direto' = decision.kind === 'confirmation' ? 'cartao' : 'direto'
  return { ...action, targetId: 'lote', requestJson: { ...request, lote, execucao, codigoConfirmacao: String(lote.length) }, beforeSnapshot: { ...(action.beforeSnapshot ?? {}), lote } as typeof action.beforeSnapshot }
}

function encodedSnapshot(action: PreparedAction) {
  const lote = (action.requestJson as typeof action.requestJson & BatchRequest).lote ?? (action.beforeSnapshot as (typeof action.beforeSnapshot & BatchSnapshot))?.lote
  if (!Array.isArray(lote)) throw new Error('Snapshot do lote ausente.')
  return JSON.stringify(lote.map((lead: BatchLead) => ({ id: lead.id, pipeline_stage: lead.pipelineStage, context_version: lead.contextVersion, etapa_efetiva: lead.etapaEfetiva, before_pipeline_stage: lead.beforePipelineStage ?? null })))
}

export function loteSql(ator: Ator, action: PreparedAction, holder: string): SQL {
  const request = action.requestJson as typeof action.requestJson & BatchRequest
  const undo = action.actionType === 'desfazer_mover_etapa_lote'
  const destination = request.etapaDestino
  if (!undo && !destination) throw new Error('Destino do lote ausente.')
  const actionGate = sql`${gate(ator, action, holder)} AND EXISTS (SELECT 1 FROM sac_operator_locks l WHERE l.company_id = ${ator.companyId} AND l.holder = ${holder}::uuid AND l.locked_until > now())`
  const after = sql`jsonb_build_object('lote', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'pipelineStage', pipeline_stage, 'contextVersion', context_version, 'etapaEfetiva', pipeline_stage, 'beforePipelineStage', before_pipeline_stage) ORDER BY id) FROM eff), '[]'::jsonb), 'movidos', (SELECT count(*) FROM eff), 'ignorados', coalesce((SELECT jsonb_agg(id ORDER BY id) FROM snap WHERE id NOT IN (SELECT id FROM eff)), '[]'::jsonb), 'semEfeito', NOT EXISTS (SELECT 1 FROM eff))`
  return sql`WITH snap AS (
    SELECT id, pipeline_stage, context_version, before_pipeline_stage FROM jsonb_to_recordset(${encodedSnapshot(action)}::jsonb) AS x(id int, pipeline_stage text, context_version int, etapa_efetiva text, before_pipeline_stage text)
  ), tenant_ok AS (
    SELECT 1 WHERE NOT EXISTS (
      SELECT 1 FROM snap s WHERE NOT EXISTS (SELECT 1 FROM recovery_leads owned WHERE owned.id = s.id AND owned.company_id = ${ator.companyId}))
  ), gate_batch AS (SELECT 1 FROM (${actionGate}) g, tenant_ok), eligible AS (
    SELECT l.id, l.pipeline_stage, coalesce(l.context_version,1) AS context_version, s.before_pipeline_stage FROM recovery_leads l JOIN snap s ON s.id = l.id
    WHERE l.company_id = ${ator.companyId} AND l.pipeline_stage IS NOT DISTINCT FROM s.pipeline_stage AND coalesce(l.context_version, 1) = s.context_version
  ), eff AS (
    UPDATE recovery_leads l SET pipeline_stage = ${undo ? sql`e.before_pipeline_stage` : sql`${destination}`} , updated_at = now(), last_action_by = ${ator.actorName + ' (Operador SAC)'}, last_action_at = now(), context_version = coalesce(l.context_version, 1) + 1
    FROM eligible e, gate_batch WHERE l.id = e.id AND l.company_id = ${ator.companyId}
      AND l.pipeline_stage IS NOT DISTINCT FROM e.pipeline_stage
      AND coalesce(l.context_version, 1) = e.context_version
    RETURNING l.id, e.pipeline_stage AS before_pipeline_stage, e.context_version AS before_context_version, l.pipeline_stage, l.context_version
  ), rec AS (
    UPDATE sac_operator_actions SET status = 'concluido', after_snapshot = ${after}, applied_at = now() WHERE id = ${action.id}::uuid AND company_id = ${ator.companyId} AND status IN ('pendente', 'aguardando_confirmacao') AND EXISTS (SELECT 1 FROM gate_batch) RETURNING id
  ), aud AS (
    INSERT INTO sac_audit_events (company_id, lead_id, type, actor_type, actor_id, actor_name, reference_type, reference_id, payload)
    SELECT ${ator.companyId}, id, 'context_updated', 'human', ${ator.userId}, ${ator.actorName}, 'sac_operator_actions', ${action.id}, jsonb_build_object('origem', 'operador_sac', 'jobId', ${action.jobId}::text, 'updatedFields', jsonb_build_array('pipelineStage'), 'de', before_pipeline_stage, 'para', pipeline_stage, 'leadId', id) FROM eff RETURNING id
  ), chk AS (SELECT 1 / CASE WHEN (SELECT count(*) FROM rec) = (SELECT count(*) FROM gate_batch) AND ((SELECT count(*) FROM eff) = 0 OR (SELECT count(*) FROM rec) = 1) AND (SELECT count(*) FROM eff) = (SELECT count(*) FROM aud) THEN 1 ELSE 0 END AS ok)
  SELECT (SELECT count(*)::int FROM eff) AS efeitos, (SELECT count(*)::int FROM rec) AS recibos, (SELECT count(*)::int FROM gate_batch) AS gates, ok FROM chk`
}

export function desfazerLoteSql(ator: Ator, action: PreparedAction, holder: string): SQL {
  return loteSql(ator, { ...action, actionType: 'desfazer_mover_etapa_lote' }, holder)
}
