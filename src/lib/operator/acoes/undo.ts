import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sacOperatorActions, sacOperatorJobs } from '../schema'
import { OperatorServiceError } from '../service'
import { carregarAcao, executarJob } from './execute'
import { finalizarJob, getJob, outcome } from './flow'
import { DESFAZER_JANELA_DIAS } from './limits'
import type { Ator, PreparedAction } from './types'
export async function desfazerAcao(ator: Ator, id: string) {
  const original = await carregarAcao(ator.companyId, id)
  const key = `undo:${id}`
  const existing = async () => (await db.select().from(sacOperatorJobs).where(and(eq(sacOperatorJobs.companyId, ator.companyId), eq(sacOperatorJobs.idempotencyKey, key))).limit(1))[0]
  const prior = await existing()
  if (prior) return { job: prior, reused: true }
  const job = await getJob(ator.companyId, original.jobId)
  if (original.status !== 'concluido' || original.afterSnapshot?.semEfeito || !['mover_etapa', 'anotar_lead'].includes(original.actionType) || !job.finishedAt)
    throw new OperatorServiceError('Esta ação não pode ser desfeita.', 409, 'NOT_UNDOABLE')
  if (Date.now() - job.finishedAt.getTime() > DESFAZER_JANELA_DIAS * 86400000) throw new OperatorServiceError('O prazo de sete dias para desfazer venceu.', 409, 'UNDO_WINDOW')
  const newId = randomUUID()
  const [created] = await db.insert(sacOperatorJobs).values({ id: newId, companyId: ator.companyId, requestedByUserId: ator.userId, role: ator.role,
    requestText: `Desfazer: ${original.requestJson.resumo}`, idempotencyKey: key, status: 'em_execucao', reservedTokens: 0, tokensIn: 0, tokensOut: 0 })
    .onConflictDoNothing({ target: [sacOperatorJobs.companyId, sacOperatorJobs.idempotencyKey] }).returning()
  if (!created) return { job: (await existing())!, reused: true }
  const a: PreparedAction = { ...original, id: randomUUID(), jobId: newId, ordinal: 1, actionType: 'desfazer_' + original.actionType,
    requestJson: { referencia: '', leadId: original.requestJson.leadId, rotulo: original.requestJson.rotulo, execucao: 'direto', desfazDe: id,
      resumo: `Desfazer: ${original.requestJson.resumo}`, etapaId: original.beforeSnapshot?.pipelineStage, noteId: original.afterSnapshot?.noteId },
    beforeSnapshot: original.afterSnapshot, afterSnapshot: null, status: 'pendente', idempotencyKey: key, appliedAt: null }
  await db.insert(sacOperatorActions).values(a)
  await finalizarJob(ator, newId, outcome(await executarJob(ator, newId)))
  return { job: await getJob(ator.companyId, newId), reused: false }
}
