import { isSwitchGeneratedPause } from '@/lib/message-job-class'
import { getIsabelaForwardOnlyCutoff } from '@/lib/isabela-forward-only-policy'

/**
 * Ordem do Gastão (12/11/2026): o "Pausar tudo" da Isabela é só do BOT (resposta
 * de IA/conversa). O disparo determinístico "Comentário vira DM" (a DM única da
 * regra configurada, mais a resposta pública/ocultação da MESMA regra) não é
 * bot e passa pela pausa, do mesmo jeito que o funil transacional da Kiwify
 * passa (message-job-class.ts: TRANSACTIONAL_BYPASS_ALLOWLIST).
 *
 * Escopo deliberadamente estreito, por slug da empresa (mesma chave do
 * allowlist transacional; não é id numérico porque o id muda entre ambientes):
 *   - só a empresa listada aqui; qualquer outra mantém o comportamento antigo;
 *   - só a pausa GERADA pela chave da empresa ("Pausar tudo"/"Pausar canal",
 *     inclusive a herdada pelo lead via 'auto (...)' e a marcada em massa);
 *   - pausa de lead feita por humano, opt-out/pedido de parar, tag "pessoa" e
 *     anti-loop continuam bloqueando SEMPRE;
 *   - nada além do envio da regra: resposta de IA, follow-up e a conversa do
 *     Direct depois da DM seguem barrados pela pausa (o lead continua pausado);
 *   - nada retroativo: só comentário com timestamp igual ou posterior ao corte.
 */
export const COMMENT_DM_PAUSE_BYPASS_COMPANY_SLUGS: readonly string[] = ['isabela-fanini']

/**
 * Corte fixo do bypass (12/11/2026 18:40 BRT, offset explícito). Comentário
 * anterior a ele nunca dispara por este caminho. Se ISABELA_FORWARD_ONLY_SINCE
 * (momento do deploy, já usado na política da Kiwify) estiver definida e for
 * posterior, ela manda; variável inválida falha fechada. Não cria variável nova.
 */
export const COMMENT_DM_PAUSE_BYPASS_DEFAULT_CUTOFF_AT = new Date('2026-11-12T18:40:00-03:00')

export interface CommentDmLeadPauseState {
  botPaused?: boolean | null
  botPausedBy?: string | null
  botPausedAll?: boolean | null
  botPausedChannel?: string | null
}

export type CommentDmPauseBypassDecision =
  | { bypass: true }
  | {
      bypass: false
      reason:
        | 'empresa_fora_da_lista'
        | 'pausa_individual_do_lead'
        | 'pausa_do_lead_sem_chave_ativa'
        | 'corte_invalido'
        | 'comentario_sem_data'
        | 'comentario_anterior_ao_corte'
    }

export function getCommentDmPauseBypassCutoff(env: Record<string, string | undefined> = process.env): Date | null {
  if (!env.ISABELA_FORWARD_ONLY_SINCE?.trim()) return COMMENT_DM_PAUSE_BYPASS_DEFAULT_CUTOFF_AT
  const deployCutoff = getIsabelaForwardOnlyCutoff(env)
  if (!deployCutoff) return null
  return deployCutoff.getTime() > COMMENT_DM_PAUSE_BYPASS_DEFAULT_CUTOFF_AT.getTime()
    ? deployCutoff
    : COMMENT_DM_PAUSE_BYPASS_DEFAULT_CUTOFF_AT
}

/**
 * Pausa do lead que o bypass NÃO pode ignorar: tudo que não é, de forma
 * positiva, pausa vinda da chave. Humano que assumiu (botPausedAll=false e sem
 * canal), opt-out, tag "pessoa" e anti-loop ficam todos aqui.
 */
function isIndividualLeadPause(lead: CommentDmLeadPauseState): boolean {
  if (lead.botPaused !== true) return false
  const by = (lead.botPausedBy ?? '').trim().toLowerCase()
  if (by.startsWith('tag:') || by.startsWith('anti-loop') || by.includes('optout') || by.includes('opt-out') || by.includes('opt_out')) return true
  return !isSwitchGeneratedPause(lead)
}

/**
 * Chamado só quando a pausa BLOQUEIA o comentário. Decide se o disparo da regra
 * de "Comentário vira DM" pode passar por ela.
 *
 * `switchBlocking`: a chave da empresa (all ou instagram) está ligada agora.
 * Lead pausado sem chave ligada (pausa residual/inconsistente) não passa: sem a
 * chave como dona da pausa não há o que "contornar".
 */
export function evaluateCommentDmPauseBypass(input: {
  companySlug: string | null | undefined
  lead: CommentDmLeadPauseState | null | undefined
  switchBlocking: boolean
  commentCreatedAt: Date | null | undefined
  env?: Record<string, string | undefined>
}): CommentDmPauseBypassDecision {
  if (!input.companySlug || !COMMENT_DM_PAUSE_BYPASS_COMPANY_SLUGS.includes(input.companySlug)) {
    return { bypass: false, reason: 'empresa_fora_da_lista' }
  }
  const lead = input.lead
  if (lead?.botPaused === true) {
    if (isIndividualLeadPause(lead)) return { bypass: false, reason: 'pausa_individual_do_lead' }
    if (!input.switchBlocking) return { bypass: false, reason: 'pausa_do_lead_sem_chave_ativa' }
  }
  const cutoff = getCommentDmPauseBypassCutoff(input.env)
  if (!cutoff) return { bypass: false, reason: 'corte_invalido' }
  const createdAt = input.commentCreatedAt
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return { bypass: false, reason: 'comentario_sem_data' }
  if (createdAt.getTime() < cutoff.getTime()) return { bypass: false, reason: 'comentario_anterior_ao_corte' }
  return { bypass: true }
}
