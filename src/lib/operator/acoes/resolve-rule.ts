import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { OperatorServiceError } from '../service'
import { matchesCommentKeywords, normalizeCommentKeywordText } from '@/lib/instagram-comment-keywords'
import { validarMensagem, validarPalavra } from './validate'
import { verificarTabelaTrava } from './lock'
import { MAX_REGRAS_CRIADAS_DIA } from './limits'
import type { Ator, PreparedAction, RuleData } from './types'

export function acaoDeRegra(type: string) { return /^(?:desfazer_)?(?:criar|editar|ativar|desativar)_regra_instagram$/.test(type) }
export async function regrasDaEmpresa(companyId: number): Promise<RuleData[]> {
  return (await db.execute<RuleData>(sql`SELECT id, name, keywords, dm_message, match_type, trigger_type, media_id, is_active,
    template_id, updated_at::text, created_at::text FROM instagram_comment_automations WHERE company_id = ${companyId} ORDER BY id`)).rows
}
export async function resolverRegra(companyId: number, referencia: string) {
  const rows = await regrasDaEmpresa(companyId)
  const id = /^#\d+$/.test(referencia) ? Number(referencia.slice(1)) : null
  const needle = normalizeCommentKeywordText(referencia)
  const found = rows.filter(r => id !== null ? r.id === id : r.keywords?.split(',').some(k => normalizeCommentKeywordText(k) === needle) || normalizeCommentKeywordText(r.name).includes(needle))
  if (!found.length) throw new OperatorServiceError('Não encontrei essa regra nesta empresa.', 404, 'RULE_NOT_FOUND')
  if (found.length > 10) throw new OperatorServiceError('Muitas regras encontradas. Informe o número da regra.', 400, 'RULE_AMBIGUOUS')
  return found
}
export function conflitosDeRegra(rows: RuleData[], target: RuleData, criar: boolean) {
  const avisos: string[] = []
  for (const row of rows) {
    if (row.id === target.id || !['comment', 'both'].includes(row.trigger_type)) continue
    const conflict = row.match_type === 'any' ? row.is_active : target.keywords.split(',').some(p => row.keywords?.split(',').some(q =>
      matchesCommentKeywords(p, q, row.match_type).matched || matchesCommentKeywords(q, p, target.match_type).matched))
    if (!conflict) continue
    if (criar) throw new OperatorServiceError(`Já existe a regra #${row.id} “${row.keywords}” (${row.is_active ? 'ativa' : 'inativa'}). Peça para editar ou ativar essa regra.`, 409, 'RULE_EXISTS')
    if (row.is_active && (row.media_id !== null || row.id < target.id || row.match_type === 'any'))
      throw new OperatorServiceError(`A regra #${row.id} tem prioridade e responderia antes. Desative-a primeiro.`, 409, 'RULE_SHADOWED')
    if (!row.is_active) avisos.push(`A regra #${row.id} está inativa e usa uma palavra conflitante.`)
  }
  return avisos
}
export async function limiteCriacao(companyId: number) {
  const result = await db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM sac_operator_actions WHERE company_id = ${companyId}
    AND action_type = 'criar_regra_instagram' AND status = 'concluido'
    AND applied_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`)
  if (result.rows[0].n >= MAX_REGRAS_CRIADAS_DIA) throw new OperatorServiceError('O limite diário de criação de regras foi atingido.', 429, 'DAILY_RULE_LIMIT')
}
export async function completarRegra(ator: Ator, action: PreparedAction): Promise<PreparedAction> {
  await verificarTabelaTrava()
  const request = { ...action.requestJson }
  delete request.esclarecimento
  const create = action.actionType === 'criar_regra_instagram'
  let before: RuleData | undefined
  let target = request.regra!
  if (!create) {
    const found = await resolverRegra(ator.companyId, request.ruleId ? `#${request.ruleId}` : request.referencia)
    if (found.length > 1) return { ...action, requestJson: { ...request, esclarecimento: { tipo: 'regra', opcoes: found.map(r => ({ id: String(r.id), label: `#${r.id} ${r.name}: ${r.keywords} (${r.is_active ? 'ativa' : 'inativa'}, ${r.trigger_type})` })) } } }
    before = found[0]
    if (before.trigger_type !== 'comment' && action.actionType !== 'desativar_regra_instagram') throw new OperatorServiceError('Este gatilho ainda não está disponível nesta fase.', 400, 'NOT_AVAILABLE')
    request.ruleId = before.id
    target = { ...before }
    if (action.actionType === 'editar_regra_instagram') {
      target.keywords = request.novaPalavra ?? target.keywords
      target.dm_message = request.novaMensagem ?? target.dm_message
      target.match_type = request.novaCorrespondencia ?? target.match_type
      if (target.name.startsWith('Operador: ')) target.name = `Operador: ${target.keywords}`.slice(0, 80)
    } else target.is_active = action.actionType === 'ativar_regra_instagram'
  } else await limiteCriacao(ator.companyId)
  const deactivate = action.actionType === 'desativar_regra_instagram'
  if (!deactivate && (target.template_id || target.match_type === 'any')) throw new OperatorServiceError('Regras de template ou de qualquer comentário só podem ser desativadas pelo operador.', 400, 'PROTECTED_RULE')
  if (!deactivate) {
    validarPalavra(target.keywords, target.match_type)
    const validation = validarMensagem(target.dm_message, { servidor: true, linkDomains: request.linkDomains })
    request.dominios = validation.dominios
    request.avisos = [...new Set([...(request.avisos ?? []), ...validation.avisos, ...conflitosDeRegra(await regrasDaEmpresa(ator.companyId), target, create)])]
  }
  request.regra = target
  request.execucao = !deactivate && (target.is_active || before?.is_active) ? 'cartao' : 'direto'
  request.codigoConfirmacao = target.keywords
  request.semEfeito = !!before && (action.actionType === 'ativar_regra_instagram' || deactivate) && target.is_active === before.is_active
  const verb = create ? 'Criar' : deactivate ? 'Desativar' : action.actionType === 'ativar_regra_instagram' ? 'Ativar' : 'Editar'
  request.resumo = request.semEfeito ? `A regra #${target.id} já está ${target.is_active ? 'ativa' : 'inativa'}.`
    : `${verb} regra ${target.id ? '#' + target.id + ' ' : ''}“${target.keywords}” (${target.is_active ? 'ativa após confirmação' : 'inativa'}).`
  if (request.execucao === 'cartao') request.avisos = [...(request.avisos ?? []), 'Ao ativar, comentários novos que correspondam à palavra podem receber esta mensagem no Direct. A mensagem pode sair mesmo com Pausar tudo ligado, conforme as regras de envio existentes. Confira as condições de envio no SAC.']
  return { ...action, targetId: before ? String(before.id) : null, requestJson: request, beforeSnapshot: before ? { regra: before } : null }
}
