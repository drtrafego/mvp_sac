import { randomUUID } from 'node:crypto'
import { OperatorServiceError, type OperatorSettings } from '../service'
import type { AcoesPlan } from './catalog'
import { resolverMarcadores, somenteMarcadores, temMarcador } from './markers'
import { resolverLead } from './resolve-lead'
import { colunasDaEmpresa, resolverEtapa } from './resolve-stage'
import { completarLote } from './batch'
import { completarRegra, acaoDeRegra } from './resolve-rule'
import { palavraDoMarcador, validarMensagem, validarTextoNota } from './validate'
import type { Ator, PreparedAction } from './types'

export const FATIA_ATIVA = 3
export function disponivelNestaFatia(type: string) {
  return ['buscar_lead', 'listar_etapas', 'listar_regras_instagram', 'listar_regras_story', 'recusar', 'mover_etapa', 'mover_etapa_lote', 'anotar_lead', 'criar_regra_instagram', 'editar_regra_instagram', 'ativar_regra_instagram', 'desativar_regra_instagram', 'criar_regra_story', 'editar_regra_story', 'ativar_regra_story', 'desativar_regra_story'].includes(type)
}
export async function completarAcao(ator: Ator, acao: PreparedAction, aliases: Record<string, string>): Promise<PreparedAction> {
  if (acaoDeRegra(acao.actionType)) return completarRegra(ator, acao)
  if (acao.actionType === 'mover_etapa_lote') return acao.requestJson.lote ? acao : completarLote(ator, acao)
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
    if (a.type === 'mover_etapa_lote') {
      const cols = await colunasDaEmpresa(ator.companyId)
      const origemTermo = resolverMarcadores(a.etapaOrigem, markers)
      const destinoTermo = resolverMarcadores(a.etapaDestino, markers)
      const sourceResolved = await resolverEtapa(ator.companyId, origemTermo, settings.stageAliases ?? {})
      const destResolved = await resolverEtapa(ator.companyId, destinoTermo, settings.stageAliases ?? {})
      if (sourceResolved.tipo !== 'ok' || destResolved.tipo !== 'ok') throw new OperatorServiceError('Escolha uma etapa sem ambiguidade para o lote.', 400, 'STAGE_AMBIGUOUS')
      const source = cols.find(c => c.id === sourceResolved.etapaId)
      const dest = cols.find(c => c.id === destResolved.etapaId)
      if (!source || !dest) throw new OperatorServiceError('A etapa informada não existe nesta empresa.', 400, 'STAGE_NOT_FOUND')
      const loteAction: PreparedAction = { id: randomUUID(), companyId: ator.companyId, jobId, ordinal: i + 1, actionType: a.type, targetId: 'lote', requestJson: { referencia: '', etapaOrigem: source.id, etapaDestino: dest.id, resumo: 'Preparar lote.', execucao: 'direto', permissao: a.type }, beforeSnapshot: null, afterSnapshot: null, status: 'pendente', idempotencyKey: `${jobId}:${i + 1}`, appliedAt: null }
      const completed = await completarLote(ator, loteAction)
      const n = completed.requestJson.lote?.length ?? 0
      completed.requestJson.resumo = n ? `Mover ${n} leads de ${source.label} para ${dest.label}.` : `Nenhum lead em ${source.label}.`
      actions.push(completed)
      continue
    }
    if (a.type === 'criar_regra_story' || a.type === 'editar_regra_story' || a.type === 'ativar_regra_story' || a.type === 'desativar_regra_story') {
      const corr = a.type === 'criar_regra_story' ? (a.correspondencia === 'contem' ? 'contains' : 'exact') : a.type === 'editar_regra_story' && a.novaCorrespondencia ? (a.novaCorrespondencia === 'contem' ? 'contains' : 'exact') : undefined
      const request: PreparedAction['requestJson'] = { referencia: '', resumo: 'Preparar regra de resposta ao story.', execucao: 'direto', linkDomains: settings.linkDomains ?? [] }
      if (a.type === 'criar_regra_story') {
        const palavra = palavraDoMarcador(a.palavra, markers, corr)
        const message = validarMensagem(a.mensagem, { markers, original, linkDomains: settings.linkDomains })
        if (new TextEncoder().encode(message.mensagem).length > 1000) throw new OperatorServiceError('A mensagem do story deve ter até 1.000 bytes.', 400, 'INVALID_MESSAGE')
        request.avisos = [...message.avisos, ...(a.ativar !== 'nao' ? ['A regra nasce inativa em modo teste. Para ativar o envio, peça “ative a regra de story em envio”.'] : [])]
        request.modo = 'observe'; request.ativar = false
        request.regra = { id: 0, name: `Operador: ${palavra}`.slice(0, 80), keywords: palavra, dm_message: message.mensagem, match_type: corr!, trigger_type: 'story', media_id: null, is_active: false, mode: 'observe', story_id: null, template_id: null, updated_at: '', created_at: '' }
      } else {
        if (/^#\d+$/.test(a.regra)) {
          if (!new RegExp(`(?<![\\p{L}\\p{N}_])${a.regra}(?!\\d)`, 'u').test(original)) throw new OperatorServiceError('O número da regra deve vir do pedido.', 400, 'MARKER_REQUIRED')
          request.referencia = a.regra
        } else {
          if (!/^#?\[(?:T\d+|PALAVRA_\d+)\]$/.test(a.regra)) throw new OperatorServiceError('A regra deve vir de uma referência do pedido.', 400, 'MARKER_REQUIRED')
          request.referencia = resolverMarcadores(a.regra, markers)
          if (/^#\d+$/.test(request.referencia) && !original.includes(request.referencia)) throw new OperatorServiceError('O número da regra deve vir do pedido.', 400, 'MARKER_REQUIRED')
        }
        if (a.type === 'editar_regra_story') { if (a.novaPalavra) request.novaPalavra = palavraDoMarcador(a.novaPalavra, markers, corr ?? 'exact'); if (a.novaMensagem) request.novaMensagem = validarMensagem(a.novaMensagem, { markers, original, linkDomains: settings.linkDomains }).mensagem; request.novaCorrespondencia = corr }
        if (a.type === 'ativar_regra_story') request.modo = a.modo === 'envio' ? 'send' : 'observe'
      }
      actions.push(await completarRegra(ator, { id: randomUUID(), companyId: ator.companyId, jobId, ordinal: i + 1, actionType: a.type, targetId: null, requestJson: request, beforeSnapshot: null, afterSnapshot: null, status: 'pendente', idempotencyKey: `${jobId}:${i + 1}`, appliedAt: null })); continue
    }
    if (a.type === 'criar_regra_instagram' || a.type === 'editar_regra_instagram' || a.type === 'ativar_regra_instagram' || a.type === 'desativar_regra_instagram') {
      if (a.type === 'criar_regra_instagram' && !['comentario', 'direct', 'ambos'].includes(a.gatilho)) continue
      const corr = a.type === 'criar_regra_instagram' ? (a.correspondencia === 'contem' ? 'contains' : 'exact') : a.type === 'editar_regra_instagram' && a.novaCorrespondencia ? (a.novaCorrespondencia === 'contem' ? 'contains' : 'exact') : undefined
      const request: PreparedAction['requestJson'] = { referencia: '', resumo: 'Preparar regra de comentário.', execucao: 'direto', linkDomains: settings.linkDomains ?? [] }
      if (a.type === 'criar_regra_instagram') {
        const palavra = palavraDoMarcador(a.palavra, markers, corr)
        const message = validarMensagem(a.mensagem, { markers, original, linkDomains: settings.linkDomains })
        request.avisos = message.avisos; request.dominios = message.dominios
        request.ativar = a.ativar
        const trigger = a.gatilho === 'comentario' ? 'comment' : a.gatilho === 'ambos' ? 'both' : 'direct'
        request.regra = { id: 0, name: `Operador: ${palavra}`.slice(0, 80), keywords: palavra, dm_message: message.mensagem, match_type: corr!, trigger_type: trigger, media_id: null, is_active: a.ativar, template_id: null, updated_at: '', created_at: '' }
      } else {
        if (/^#\d+$/.test(a.regra)) {
          if (!new RegExp(`(?<![\\p{L}\\p{N}_])${a.regra}(?!\\d)`, 'u').test(original)) throw new OperatorServiceError('O número da regra deve vir do pedido.', 400, 'MARKER_REQUIRED')
          request.referencia = a.regra
        } else {
          if (!/^#?\[(?:T\d+|PALAVRA_\d+)\]$/.test(a.regra)) throw new OperatorServiceError('A regra deve vir de uma referência do pedido.', 400, 'MARKER_REQUIRED')
          request.referencia = resolverMarcadores(a.regra, markers)
          if (/^#\d+$/.test(request.referencia) && !original.includes(request.referencia)) throw new OperatorServiceError('O número da regra deve vir do pedido.', 400, 'MARKER_REQUIRED')
        }
        if (a.type === 'editar_regra_instagram') {
          if (a.novaPalavra) request.novaPalavra = palavraDoMarcador(a.novaPalavra, markers, corr ?? 'exact')
          if (a.novaMensagem) { const message = validarMensagem(a.novaMensagem, { markers, original, linkDomains: settings.linkDomains }); request.novaMensagem = message.mensagem; request.avisos = message.avisos }
          request.novaCorrespondencia = corr
        }
      }
      actions.push(await completarRegra(ator, { id: randomUUID(), companyId: ator.companyId, jobId, ordinal: i + 1, actionType: a.type, targetId: null, requestJson: request, beforeSnapshot: null, afterSnapshot: null, status: 'pendente', idempotencyKey: `${jobId}:${i + 1}`, appliedAt: null }))
      continue
    }
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
