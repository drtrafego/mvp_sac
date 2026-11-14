import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sacOperatorActions, sacOperatorJobs } from '../schema'
import { OperatorServiceError } from '../service'
import { carregarAcao } from './execute'
import { decidirExecucao, finalizarJob, getJob, outcome } from './flow'
import { verificarTabelaTrava } from './lock'
import { validarMensagem, validarPalavra } from './validate'
import { acaoDeRegra, conflitosDeRegra, regrasDaEmpresa } from './resolve-rule'
import { DESFAZER_JANELA_DIAS } from './limits'
import type { Ator, PreparedAction } from './types'
export async function desfazerAcao(ator: Ator, id: string) {
  const original = await carregarAcao(ator.companyId, id)
  const key = `undo:${id}`
  const existing = async () => (await db.select().from(sacOperatorJobs).where(and(eq(sacOperatorJobs.companyId, ator.companyId), eq(sacOperatorJobs.idempotencyKey, key))).limit(1))[0]
  const prior = await existing()
  if (prior) return { job: prior, reused: true }
  const job = await getJob(ator.companyId, original.jobId)
  if (original.status !== 'concluido' || original.afterSnapshot?.semEfeito || (!['mover_etapa', 'anotar_lead'].includes(original.actionType) && (!acaoDeRegra(original.actionType) || original.actionType.startsWith('desfazer_'))) || !job.finishedAt)
    throw new OperatorServiceError('Esta ação não pode ser desfeita.', 409, 'NOT_UNDOABLE')
  if (original.actionType === 'desativar_regra_instagram' && original.afterSnapshot?.regra?.trigger_type !== 'comment') throw new OperatorServiceError('A reativação de Direct e ambos estará disponível na próxima fase.', 409, 'NOT_UNDOABLE')
  if (Date.now() - job.finishedAt.getTime() > DESFAZER_JANELA_DIAS * 86400000) throw new OperatorServiceError('O prazo de sete dias para desfazer venceu.', 409, 'UNDO_WINDOW')
  if (acaoDeRegra(original.actionType)) await verificarTabelaTrava()
  let ruleRequest: PreparedAction['requestJson'] | undefined
  if (acaoDeRegra(original.actionType)) {
    const before = original.beforeSnapshot?.regra
    const after = original.afterSnapshot!.regra!
    const edit = original.actionType === 'editar_regra_instagram'
    const target = edit ? { ...before!, id: after.id } : { ...after, is_active: original.actionType === 'desativar_regra_instagram' }
    const card = edit ? after.is_active : target.is_active
    let avisos: string[] = []
    let dominios: string[] = []
    if (card) {
      if (target.template_id || target.match_type === 'any') throw new OperatorServiceError('Essa regra só pode ser desativada pelo operador.', 400, 'PROTECTED_RULE')
      validarPalavra(target.keywords, target.match_type)
      const config = await db.execute<{ domains: string }>(sql`SELECT link_domains::text AS domains FROM sac_operator_company_settings WHERE company_id = ${ator.companyId}`)
      const checked = validarMensagem(target.dm_message, { servidor: true, linkDomains: JSON.parse(config.rows[0]?.domains ?? '[]') })
      dominios = checked.dominios
      avisos = [...checked.avisos, ...conflitosDeRegra(await regrasDaEmpresa(ator.companyId), target, false), 'Ao confirmar, comentários novos podem receber esta mensagem no Direct, inclusive com Pausar tudo ligado conforme as regras de envio existentes.']
    }
    ruleRequest = { referencia: `#${after.id}`, ruleId: after.id, regra: target, desfazDe: id, resumo: `Desfazer: ${original.requestJson.resumo}`,
      execucao: card ? 'cartao' : 'direto', codigoConfirmacao: target.keywords, avisos, dominios,
      permissao: edit ? 'editar_regra_instagram' : target.is_active ? 'ativar_regra_instagram' : 'desativar_regra_instagram' }
  }
  const newId = randomUUID()
  const [created] = await db.insert(sacOperatorJobs).values({ id: newId, companyId: ator.companyId, requestedByUserId: ator.userId, role: ator.role,
    requestText: `Desfazer: ${original.requestJson.resumo}`, idempotencyKey: key, status: 'em_execucao', reservedTokens: 0, tokensIn: 0, tokensOut: 0 })
    .onConflictDoNothing({ target: [sacOperatorJobs.companyId, sacOperatorJobs.idempotencyKey] }).returning()
  if (!created) return { job: (await existing())!, reused: true }
  const a: PreparedAction = { ...original, id: randomUUID(), jobId: newId, ordinal: 1, actionType: 'desfazer_' + original.actionType,
    requestJson: { referencia: '', leadId: original.requestJson.leadId, rotulo: original.requestJson.rotulo, execucao: 'direto', desfazDe: id,
      resumo: `Desfazer: ${original.requestJson.resumo}`, etapaId: original.beforeSnapshot?.pipelineStage, noteId: original.afterSnapshot?.noteId },
    beforeSnapshot: original.afterSnapshot, afterSnapshot: null, status: 'pendente', idempotencyKey: key, appliedAt: null }
  if (ruleRequest) a.requestJson = ruleRequest
  await db.insert(sacOperatorActions).values(a)
  await finalizarJob(ator, newId, outcome(await decidirExecucao(ator, newId, [a])))
  return { job: await getJob(ator.companyId, newId), reused: false }
}
