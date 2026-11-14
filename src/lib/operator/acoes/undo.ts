import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sacOperatorActions, sacOperatorJobs } from '../schema'
import { OperatorServiceError } from '../service'
import { carregarAcao } from './execute'
import { decidirExecucao, finalizarJob, getJob, outcome } from './flow'
import { verificarTabelaTrava } from './lock'
import { validarMensagem, validarPalavra } from './validate'
import { acaoDeRegra, conflitosDeRegra, conflitosDeStory, regrasStoryDaEmpresa, regrasDaEmpresa } from './resolve-rule'
import { DESFAZER_JANELA_DIAS } from './limits'
import type { Ator, PreparedAction } from './types'
export async function desfazerAcao(ator: Ator, id: string) {
  const original = await carregarAcao(ator.companyId, id)
  const key = `undo:${id}`
  const existing = async () => (await db.select().from(sacOperatorJobs).where(and(eq(sacOperatorJobs.companyId, ator.companyId), eq(sacOperatorJobs.idempotencyKey, key))).limit(1))[0]
  const prior = await existing()
  if (prior) return { job: prior, reused: true }
  const job = await getJob(ator.companyId, original.jobId)
  if (original.status !== 'concluido' || original.afterSnapshot?.semEfeito || (!['mover_etapa', 'mover_etapa_lote', 'anotar_lead'].includes(original.actionType) && (!acaoDeRegra(original.actionType) || original.actionType.startsWith('desfazer_'))) || !job.finishedAt)
    throw new OperatorServiceError('Esta ação não pode ser desfeita.', 409, 'NOT_UNDOABLE')
  if (Date.now() - job.finishedAt.getTime() > DESFAZER_JANELA_DIAS * 86400000) throw new OperatorServiceError('O prazo de sete dias para desfazer venceu.', 409, 'UNDO_WINDOW')
  if (acaoDeRegra(original.actionType)) await verificarTabelaTrava()
  let ruleRequest: PreparedAction['requestJson'] | undefined
  if (acaoDeRegra(original.actionType)) {
    const before = original.beforeSnapshot?.regra
    const after = original.afterSnapshot!.regra!
    const story = original.actionType.endsWith('_story')
    const edit = original.actionType.startsWith('editar_')
    const target = (edit || (story && before)) ? { ...before!, id: after.id } : { ...after, is_active: original.actionType.startsWith('desativar_') }
    const card = (edit ? after.is_active || target.is_active : target.is_active) && (!story || target.mode === 'send')
    let avisos: string[] = []
    let dominios: string[] = []
    if (card) {
      if (target.template_id || target.match_type === 'any') throw new OperatorServiceError('Essa regra só pode ser desativada pelo operador.', 400, 'PROTECTED_RULE')
      validarPalavra(target.keywords, target.match_type)
      const config = await db.execute<{ domains: string }>(sql`SELECT link_domains::text AS domains FROM sac_operator_company_settings WHERE company_id = ${ator.companyId}`)
      const checked = validarMensagem(target.dm_message, { servidor: true, linkDomains: JSON.parse(config.rows[0]?.domains ?? '[]') })
      if (story && new TextEncoder().encode(checked.mensagem).length > 1000) throw new OperatorServiceError('Mensagem de story excede 1.000 bytes.', 400, 'INVALID_MESSAGE')
      dominios = checked.dominios
      avisos = [...checked.avisos, ...(story ? conflitosDeStory(await regrasStoryDaEmpresa(ator.companyId), target, false) : conflitosDeRegra(await regrasDaEmpresa(ator.companyId), target, false)), target.trigger_type === 'story' ? 'Esta regra vale para quem responder a story.' : 'Ao confirmar, novos comentários ou mensagens no Direct podem receber esta mensagem, conforme o gatilho. No Direct, a IA não responde essa mensagem. A regra pode enviar mesmo com Pausar tudo ligado conforme as regras de envio existentes.']
    }
    ruleRequest = { referencia: `#${after.id}`, ruleId: after.id, regra: target, desfazDe: id, resumo: `Desfazer: ${original.requestJson.resumo}`,
      execucao: card ? 'cartao' : 'direto', codigoConfirmacao: target.keywords, avisos, dominios,
      permissao: edit ? (after.trigger_type === 'story' ? 'editar_regra_story' : 'editar_regra_instagram') : target.is_active ? (after.trigger_type === 'story' ? 'ativar_regra_story' : 'ativar_regra_instagram') : (after.trigger_type === 'story' ? 'desativar_regra_story' : 'desativar_regra_instagram') }
  }
  const newId = randomUUID()
  const [created] = await db.insert(sacOperatorJobs).values({ id: newId, companyId: ator.companyId, requestedByUserId: ator.userId, role: ator.role,
    requestText: `Desfazer: ${original.requestJson.resumo}`, idempotencyKey: key, status: 'em_execucao', reservedTokens: 0, tokensIn: 0, tokensOut: 0 })
    .onConflictDoNothing({ target: [sacOperatorJobs.companyId, sacOperatorJobs.idempotencyKey] }).returning()
  if (!created) return { job: (await existing())!, reused: true }
  const a: PreparedAction = { ...original, id: randomUUID(), jobId: newId, ordinal: 1, actionType: 'desfazer_' + original.actionType,
    requestJson: { referencia: '', leadId: original.requestJson.leadId, rotulo: original.requestJson.rotulo, execucao: 'direto', desfazDe: id,
      resumo: `Desfazer: ${original.requestJson.resumo}`, etapaId: original.beforeSnapshot?.pipelineStage, etapaOrigem: original.requestJson.etapaDestino, etapaDestino: original.requestJson.etapaOrigem, lote: original.afterSnapshot?.lote, noteId: original.afterSnapshot?.noteId },
    beforeSnapshot: original.afterSnapshot, afterSnapshot: null, status: 'pendente', idempotencyKey: key, appliedAt: null }
  if (ruleRequest) a.requestJson = ruleRequest
  await db.insert(sacOperatorActions).values(a)
  await finalizarJob(ator, newId, outcome(await decidirExecucao(ator, newId, [a])))
  return { job: await getJob(ator.companyId, newId), reused: false }
}
