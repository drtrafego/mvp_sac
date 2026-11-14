import { randomUUID } from 'node:crypto'
import { OperatorServiceError, type OperatorSettings } from '../service'
import type { AcoesPlan } from './catalog'
import { resolverMarcadores, somenteMarcadores, temMarcador } from './markers'
import { resolverLead } from './resolve-lead'
import { colunasDaEmpresa, resolverEtapa } from './resolve-stage'
import { validarTextoNota } from './validate'
import type { Ator, PreparedAction } from './types'

export const FATIA_ATIVA = 1
export function disponivelNestaFatia(type: string) {
  return ['buscar_lead', 'listar_etapas', 'listar_regras_instagram', 'recusar', 'mover_etapa', 'anotar_lead'].includes(type)
}
export async function completarAcao(ator: Ator, acao: PreparedAction, aliases: Record<string, string>): Promise<PreparedAction> {
  const request = { ...acao.requestJson }
  delete request.esclarecimento
  const found = await resolverLead(ator.companyId, request.leadId ? `#${request.leadId}` : request.referencia)
  if (found.tipo === 'incompleto') throw new OperatorServiceError('Informe pelo menos quatro dígitos do final do telefone ou o identificador com #.', 400, 'LEAD_AMBIGUOUS')
  if (found.tipo === 'nenhum') throw new OperatorServiceError('Não encontrei esse lead nesta empresa.', 404, 'LEAD_NOT_FOUND')
  if (found.tipo === 'muitos') throw new OperatorServiceError('Muitos leads com esse nome, informe sobrenome ou final do telefone.', 400, 'LEAD_AMBIGUOUS')
  if (found.tipo === 'esclarecer') return { ...acao, requestJson: { ...request, esclarecimento: { tipo: 'lead', candidatos: found.candidatos } } }
  const lead = found.lead
  request.leadId = lead.id
  request.rotulo = lead.rotulo
  const before = { pipelineStage: lead.pipelineStageBruto, etapaEfetiva: lead.etapaEfetiva, contextVersion: lead.contextVersion }
  if (acao.actionType === 'mover_etapa') {
    const stage = request.etapaId
      ? (await colunasDaEmpresa(ator.companyId)).find(c => c.id === request.etapaId)
      : undefined
    if (request.etapaId && !stage) throw new OperatorServiceError('A etapa escolhida não existe mais.', 409, 'CONFLICT')
    const resolved = stage ? { tipo: 'ok' as const, etapaId: stage.id, label: stage.label } : await resolverEtapa(ator.companyId, request.etapa!, aliases)
    if (resolved.tipo === 'esclarecer') request.esclarecimento = { tipo: 'etapa', termo: resolved.termo, opcoes: resolved.opcoes }
    else {
      request.etapaId = resolved.etapaId
      request.semEfeito = lead.etapaEfetiva === resolved.etapaId
      request.resumo = request.semEfeito ? `${lead.rotulo} já estava em ${resolved.label}.` : `Mover ${lead.rotulo} de ${lead.etapaEfetiva} para ${resolved.label}.`
    }
  } else request.resumo = `Anotar no lead ${lead.rotulo}.`
  return { ...acao, targetId: String(lead.id), requestJson: request, beforeSnapshot: before }
}
export async function prepararPlano(ator: Ator, jobId: string, plan: AcoesPlan, markers: Map<string, string>, original: string, settings: OperatorSettings) {
  const actions: PreparedAction[] = []
  for (const [i, a] of plan.actions.entries()) {
    if (a.type !== 'mover_etapa' && a.type !== 'anotar_lead') continue
    if (!temMarcador(a.lead, ['T', 'CONTATO'])) throw new OperatorServiceError('Use a referência do pedido para identificar o lead.', 400, 'MARKER_REQUIRED')
    let referencia = resolverMarcadores(somenteMarcadores(a.lead), markers)
    // A anonimização mantém # fora do marcador. Só o texto humano pode
    // autorizar seu uso como ID; um # inventado pelo modelo não tem efeito.
    if (/^\d{1,9}$/.test(referencia)
      && new RegExp(`(?<![\\p{L}\\p{N}_])#${referencia}(?!\\d)`, 'u').test(original)
      && !new RegExp(`(?<![#\\p{L}\\p{N}_])${referencia}(?!\\d)`, 'u').test(original)) referencia = `#${referencia}`
    const request = a.type === 'anotar_lead' ? { ...validarTextoNota(resolverMarcadores(a.texto, markers), original), referencia }
      : { referencia, etapa: resolverMarcadores(a.etapa, markers) }
    actions.push(await completarAcao(ator, {
      id: randomUUID(), companyId: ator.companyId, jobId, ordinal: i + 1, actionType: a.type, targetId: null,
      requestJson: { ...request, resumo: 'Aguardando identificação do lead.', execucao: 'direto' }, beforeSnapshot: null, afterSnapshot: null,
      status: 'pendente', idempotencyKey: `${jobId}:${i + 1}`, appliedAt: null,
    }, settings.stageAliases ?? {}))
  }
  return actions
}
