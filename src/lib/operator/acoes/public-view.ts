import { acaoDeRegra } from './resolve-rule'
import { DESFAZER_JANELA_DIAS } from './limits'
import type { OperatorJob } from '../service'
import type { ActionView, JobView, PreparedAction } from './types'
export function publicJob(job: OperatorJob): JobView {
  return { id: job.id, status: job.status, waitingReason: job.waitingReason, resultText: job.resultText, errorCode: job.errorCode, confirmationExpiresAt: job.confirmationExpiresAt, planHash: job.planHash }
}
export function publicAction(a: PreparedAction, job: OperatorJob, desfeita: boolean, erroDesfazer?: string, desfazerIniciado = false): ActionView {
  return { id: a.id, tipo: a.actionType, status: a.status, resumo: a.afterSnapshot?.lote ? `${a.requestJson.resumo} Movidos: ${a.afterSnapshot.movidos ?? 0}. Ignorados: ${a.afterSnapshot.ignorados?.length ? a.afterSnapshot.ignorados.map(id => '#' + id).join(', ') : 'nenhum'}.` : a.requestJson.resumo, erro: a.afterSnapshot?.erro,
    desfeita, erroDesfazer, podeDesfazer: !desfazerIniciado && !desfeita && a.status === 'concluido' && !a.afterSnapshot?.semEfeito && (['mover_etapa', 'mover_etapa_lote', 'anotar_lead'].includes(a.actionType) || (acaoDeRegra(a.actionType) && !a.actionType.startsWith('desfazer_')))
      && !!job.finishedAt && Date.now() - job.finishedAt.getTime() <= DESFAZER_JANELA_DIAS * 86400000,
    cartao: a.requestJson.execucao === 'cartao' && job.waitingReason === 'confirmacao' && job.status === 'aguardando_confirmacao' ? {
      mensagem: a.requestJson.regra?.dm_message ?? a.requestJson.resumo, palavra: a.requestJson.regra?.keywords ?? String(a.requestJson.lote?.length ?? 0),
      correspondencia: a.requestJson.lote ? 'Quantidade de leads' : a.requestJson.regra?.match_type === 'exact' ? 'Igual à palavra' : 'Contém a palavra',
      alcance: a.requestJson.lote ? `Somente os ${a.requestJson.lote.length} leads do lote preparado.` : a.requestJson.regra?.trigger_type === 'story' ? 'Respostas a QUALQUER story.' : a.requestJson.regra?.trigger_type === 'direct' ? 'Qualquer Direct que contenha a palavra (a IA não responde essa mensagem).' : a.requestJson.regra?.trigger_type === 'both' ? 'Comentários novos em TODOS os posts e qualquer Direct que contenha a palavra (a IA não responde essa mensagem).' : 'Comentários novos em TODOS os posts.', avisos: a.requestJson.avisos ?? [], dominios: a.requestJson.dominios ?? [], codigo: a.requestJson.codigoConfirmacao!,
    } : undefined,
    esclarecimento: a.status === 'pendente' && job.status === 'aguardando_confirmacao' ? a.requestJson.esclarecimento : undefined }
}
