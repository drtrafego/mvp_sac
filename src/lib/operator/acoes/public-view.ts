import { DESFAZER_JANELA_DIAS } from './limits'
import type { OperatorJob } from '../service'
import type { ActionView, JobView, PreparedAction } from './types'
export function publicJob(job: OperatorJob): JobView {
  return { id: job.id, status: job.status, waitingReason: job.waitingReason, resultText: job.resultText, errorCode: job.errorCode, confirmationExpiresAt: job.confirmationExpiresAt }
}
export function publicAction(a: PreparedAction, job: OperatorJob, desfeita: boolean, erroDesfazer?: string, desfazerIniciado = false): ActionView {
  return { id: a.id, tipo: a.actionType, status: a.status, resumo: a.requestJson.resumo, erro: a.afterSnapshot?.erro,
    desfeita, erroDesfazer, podeDesfazer: !desfazerIniciado && !desfeita && a.status === 'concluido' && !a.afterSnapshot?.semEfeito && ['mover_etapa', 'anotar_lead'].includes(a.actionType)
      && !!job.finishedAt && Date.now() - job.finishedAt.getTime() <= DESFAZER_JANELA_DIAS * 86400000,
    esclarecimento: a.status === 'pendente' && job.status === 'aguardando_confirmacao' ? a.requestJson.esclarecimento : undefined }
}
