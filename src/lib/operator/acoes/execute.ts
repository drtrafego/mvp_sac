import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sacOperatorActions } from '../schema'
import { OperatorServiceError } from '../service'
import { efeitoSql, gate, postgresCode } from './sql'
import { colunasDaEmpresa } from './resolve-stage'
import type { Ator, PreparedAction } from './types'
export async function carregarAcao(companyId: number, id: string): Promise<PreparedAction> {
  const [row] = await db.select().from(sacOperatorActions).where(and(eq(sacOperatorActions.companyId, companyId), eq(sacOperatorActions.id, id))).limit(1)
  if (!row) throw new OperatorServiceError('Ação não encontrada.', 404, 'ACTION_NOT_FOUND')
  return row as PreparedAction
}
export async function acoesDoJob(companyId: number, jobId: string): Promise<PreparedAction[]> {
  return await db.select().from(sacOperatorActions).where(and(eq(sacOperatorActions.companyId, companyId), eq(sacOperatorActions.jobId, jobId))).orderBy(asc(sacOperatorActions.ordinal)) as PreparedAction[]
}
export async function falharAcao(ator: Ator, id: string, code: string) {
  await db.execute(sql`UPDATE sac_operator_actions SET status = 'falhou', after_snapshot = jsonb_build_object('erro', ${code}::text)
    WHERE id = ${id}::uuid AND company_id = ${ator.companyId} AND (status IN ('pendente', 'aguardando_confirmacao') OR (status = 'cancelado' AND ${code} = 'OPERATOR_INCONSISTENT'))`)
  return carregarAcao(ator.companyId, id)
}
export async function executarAcao(ator: Ator, jobId: string, action: PreparedAction): Promise<PreparedAction> {
  const a = await carregarAcao(ator.companyId, action.id)
  if (a.jobId !== jobId) throw new OperatorServiceError('Ação não encontrada.', 404, 'ACTION_NOT_FOUND')
  if (a.status !== 'pendente' && a.status !== 'aguardando_confirmacao') return a
  if (a.requestJson.esclarecimento) return falharAcao(ator, a.id, 'CLARIFICATION_REQUIRED')
  if (a.actionType === 'mover_etapa' && !(await colunasDaEmpresa(ator.companyId)).some(c => c.id === a.requestJson.etapaId)) return falharAcao(ator, a.id, 'CONFLICT')
  try {
    if (a.requestJson.semEfeito) {
      const noop = await db.execute<{ efeitos: number; gates: number }>(sql`WITH gate AS (${gate(ator, a)}), rec AS (UPDATE sac_operator_actions
        SET status = 'concluido', after_snapshot = '{"semEfeito":true}'::jsonb, applied_at = now()
        WHERE id = ${a.id}::uuid AND company_id = ${ator.companyId} AND status = 'pendente' AND EXISTS (SELECT 1 FROM gate)
          AND EXISTS (SELECT 1 FROM recovery_leads WHERE id = ${a.requestJson.leadId} AND company_id = ${ator.companyId}
            AND pipeline_stage IS NOT DISTINCT FROM ${a.beforeSnapshot?.pipelineStage}::text
            AND coalesce(context_version, 1) = ${a.beforeSnapshot?.contextVersion}) RETURNING id)
        SELECT (SELECT count(*) FROM rec)::int AS efeitos, (SELECT count(*) FROM gate)::int AS gates`)
      if (!noop.rows[0]?.efeitos) return falharAcao(ator, a.id, noop.rows[0]?.gates ? 'CONFLICT' : 'GATE_CLOSED')
    } else {
      const noteId = a.actionType === 'anotar_lead' ? (await db.execute<{ id: number }>(sql`SELECT nextval(pg_get_serial_sequence('sac_internal_notes', 'id'))::int AS id`)).rows[0].id : undefined
      const result = await db.execute<{ efeitos: number; gates: number }>(efeitoSql(ator, a, noteId))
      if (result.rows[0].efeitos === 0) return falharAcao(ator, a.id, result.rows[0].gates ? 'CONFLICT' : 'GATE_CLOSED')
    }
    const done = await carregarAcao(ator.companyId, a.id)
    return done.status === 'pendente' ? falharAcao(ator, a.id, 'GATE_CLOSED') : done
  } catch (error) { return falharAcao(ator, a.id, postgresCode(error) === '22012' ? 'OPERATOR_INCONSISTENT' : 'EXECUTION_FAILED') }
}
export async function executarJob(ator: Ator, jobId: string) {
  const results: PreparedAction[] = []
  let failed = false
  for (const a of await acoesDoJob(ator.companyId, jobId)) {
    const result = failed ? await falharAcao(ator, a.id, 'ANTERIOR_FALHOU') : await executarAcao(ator, jobId, a)
    results.push(result)
    if (result.status !== 'concluido') failed = true
  }
  return results
}
