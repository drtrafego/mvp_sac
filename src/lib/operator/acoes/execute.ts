import { randomUUID } from 'node:crypto'
import { adquirirTrava, liberarTrava } from './lock'
import { acaoDeRegra, conflitosDeRegra, regrasDaEmpresa, limiteCriacao } from './resolve-rule'
import { validarMensagem, validarPalavra } from './validate'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sacOperatorActions } from '../schema'
import { OperatorServiceError } from '../service'
import { efeitoSql, regraSql, gate, postgresCode } from './sql'
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
export async function executarAcao(ator: Ator, jobId: string, action: PreparedAction, holder?: string): Promise<PreparedAction> {
  const a = await carregarAcao(ator.companyId, action.id)
  if (a.jobId !== jobId) throw new OperatorServiceError('Ação não encontrada.', 404, 'ACTION_NOT_FOUND')
  if (a.status !== 'pendente' && a.status !== 'aguardando_confirmacao') return a
  if (a.requestJson.esclarecimento) return falharAcao(ator, a.id, 'CLARIFICATION_REQUIRED')
  if (a.actionType === 'mover_etapa' && !(await colunasDaEmpresa(ator.companyId)).some(c => c.id === a.requestJson.etapaId)) return falharAcao(ator, a.id, 'CONFLICT')
  try {
    if (acaoDeRegra(a.actionType)) {
      if (!holder) return falharAcao(ator, a.id, 'GATE_CLOSED')
      const rows = await regrasDaEmpresa(ator.companyId)
      const target = a.requestJson.regra!
      const create = a.actionType === 'criar_regra_instagram'
      const current = rows.find(r => r.id === a.beforeSnapshot?.regra?.id)
      if (!create && (!current || current.updated_at !== a.beforeSnapshot?.regra?.updated_at)) return falharAcao(ator, a.id, 'CONFLICT')
      if (create) await limiteCriacao(ator.companyId)
      // Desligar e apagar uma criação nunca usada não aumentam envios.
      if (create || target.is_active || a.actionType.includes('editar_')) {
        if (target.trigger_type !== 'comment') return falharAcao(ator, a.id, 'NOT_AVAILABLE')
        if (target.template_id || target.match_type === 'any') return falharAcao(ator, a.id, 'PROTECTED_RULE')
        validarPalavra(target.keywords, target.match_type)
        const config = await db.execute<{ domains: string }>(sql`SELECT link_domains::text AS domains FROM sac_operator_company_settings WHERE company_id = ${ator.companyId}`)
        validarMensagem(target.dm_message, { servidor: true, linkDomains: JSON.parse(config.rows[0]?.domains ?? '[]') })
        conflitosDeRegra(rows, target, create)
      }
      if (a.requestJson.semEfeito) {
        const result = await db.execute<{ efeitos: number }>(sql`WITH gate AS (${gate(ator, a, holder)}), rec AS (
          UPDATE sac_operator_actions SET status = 'concluido', after_snapshot = '{"semEfeito":true}'::jsonb, applied_at = now()
          WHERE id = ${a.id}::uuid AND company_id = ${ator.companyId} AND status IN ('pendente','aguardando_confirmacao') AND EXISTS (SELECT 1 FROM gate)
            AND EXISTS (SELECT 1 FROM instagram_comment_automations WHERE id = ${target.id} AND company_id = ${ator.companyId} AND updated_at::text = ${current!.updated_at}) RETURNING id)
          SELECT count(*)::int efeitos FROM rec`)
        if (!result.rows[0]?.efeitos) return falharAcao(ator, a.id, 'GATE_CLOSED')
      } else {
        const id = create ? (await db.execute<{ id: number }>(sql`SELECT nextval(pg_get_serial_sequence('instagram_comment_automations', 'id'))::int AS id`)).rows[0].id : undefined
        let checkedRows = rows
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const result = await db.execute<{ efeitos: number; gates: number }>(regraSql(ator, a, holder, Math.max(0, ...checkedRows.map(r => r.id)), id))
            if (!result.rows[0]?.efeitos) return falharAcao(ator, a.id, result.rows[0]?.gates ? 'CONFLICT' : 'GATE_CLOSED')
            break
          } catch (error) {
            if (!create || attempt || postgresCode(error) !== '22012') throw error
            // O painel não participa do lock. Reconfere uma vez após o rollback
            // integral, antes de tentar usar novamente o mesmo id pré-alocado.
            checkedRows = await regrasDaEmpresa(ator.companyId)
            conflitosDeRegra(checkedRows, target, true)
            await limiteCriacao(ator.companyId)
          }
        }
      }
    } else if (a.requestJson.semEfeito) {
      const noop = await db.execute<{ efeitos: number; gates: number }>(sql`WITH gate AS (${gate(ator, a)}), rec AS (UPDATE sac_operator_actions
        SET status = 'concluido', after_snapshot = '{"semEfeito":true}'::jsonb, applied_at = now()
        WHERE id = ${a.id}::uuid AND company_id = ${ator.companyId} AND status IN ('pendente', 'aguardando_confirmacao') AND EXISTS (SELECT 1 FROM gate)
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
  } catch (error) { return falharAcao(ator, a.id, error instanceof OperatorServiceError ? error.code : postgresCode(error) === '22012' ? 'OPERATOR_INCONSISTENT' : 'EXECUTION_FAILED') }
}
export async function executarJob(ator: Ator, jobId: string) {
  const actions = await acoesDoJob(ator.companyId, jobId)
  const holder = actions.some(a => acaoDeRegra(a.actionType)) ? randomUUID() : undefined
  const results: PreparedAction[] = []
  let locked = false
  let failed = false
  try {
    if (holder) {
      locked = await adquirirTrava(ator.companyId, holder)
      if (!locked) {
        for (const a of actions) results.push(await falharAcao(ator, a.id, 'BUSY'))
        return results
      }
    }
    for (const a of actions) {
      const result = failed ? await falharAcao(ator, a.id, 'ANTERIOR_FALHOU') : await executarAcao(ator, jobId, a, holder)
      results.push(result)
      if (result.status !== 'concluido') failed = true
    }
    return results
  } catch (error) {
    for (const a of actions) await falharAcao(ator, a.id, postgresCode(error) === '42P01' ? 'GATE_CLOSED' : 'EXECUTION_FAILED')
    return acoesDoJob(ator.companyId, jobId)
  } finally { if (holder && locked) await liberarTrava(ator.companyId, holder) }
}
