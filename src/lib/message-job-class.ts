// Arquivo folha, sem imports: pix-followup-policy importa isOptOutPause daqui, então
// importar as constantes de volta criaria ciclo (TDZ). Os literais de jobType abaixo
// são conferidos contra PIX_FOLLOWUP_JOB_TYPE / ISABELA_BOLETO_JOB_TYPE no teste.


/**
 * Classificação dos jobs de mensagem do cron para a PAUSA DO BOT.
 *
 * A pausa (lead, canal, geral e a chave company_pause_switches) existe para
 * impedir o bot CONVERSACIONAL: resposta da IA, follow-up da IA, automação de
 * comentário/DM e disparo promocional. Ela NÃO pode cancelar a mensagem de
 * evento transacional que vem do checkout (compra aprovada, boleto, Pix,
 * cartão recusado e o funil pós-compra): o cliente precisa receber o boleto,
 * o aviso de Pix e o acesso mesmo com o atendimento por IA desligado.
 *
 *   transactional  -> a pausa NÃO bloqueia (opt-out e consentimento continuam
 *                     bloqueando, ver cron e isOptOutPause)
 *   conversational -> nasce da conversa/IA (ex.: convite do Portal depois do
 *                     desafio): a pausa bloqueia
 *   promotional    -> upsell, disparo em massa, outreach manual, job sem
 *                     jobType, qualquer job fora da lista de permissão: a
 *                     pausa bloqueia
 *
 * Regra de dúvida: fora da lista de permissão, é promocional (bloqueado).
 */
export type MessageJobClass = 'transactional' | 'conversational' | 'promotional'

/**
 * LISTA DE PERMISSÃO do bypass transacional (a ordem do Gastão cobre só o
 * funil de evento da Kiwify da Isabela). Um job escapa da pausa SOMENTE se a
 * empresa, a plataforma do lead e o jobType EXPLÍCITO do job estão aqui. Nada
 * é deduzido do estado do lead (eventType/platform são sobrescrevíveis por
 * POST /api/leads), e job sem jobType nunca escapa. Recuperação de carrinho de
 * Hotmart/Greenn/Zouti e de outras empresas segue bloqueada pela pausa, como
 * antes. Para liberar outra empresa/plataforma, acrescente uma entrada aqui
 * (e garanta que o webhook dela grave jobType explícito).
 */
export interface TransactionalBypassRule {
  companySlug: string
  platform: string
  jobTypes: readonly string[]
}

export const TRANSACTIONAL_BYPASS_ALLOWLIST: readonly TransactionalBypassRule[] = [
  {
    companySlug: 'isabela-fanini',
    platform: 'kiwify',
    jobTypes: [
      'isabela_purchase_sequence', // funil pós-compra (boas-vindas, D+1, D+10)
      'boleto_followup_immediate', // boleto emitido (ISABELA_BOLETO_JOB_TYPE)
      'isabela_cartao_recusado', // cartão recusado
      'pix_followup_60m', // Pix não pago, 60 min (PIX_FOLLOWUP_JOB_TYPE)
    ],
  },
]

/** Jobs que nascem da conversa/IA, não de um evento de checkout. */
export const CONVERSATIONAL_JOB_TYPES: ReadonlySet<string> = new Set([
  'isabela_portal_after_challenge', // agendado por scheduleIsabelaPortalTemplate (ai-reply.ts)
])

/** botPausedBy de pausa causada por pedido de parar do cliente: continua bloqueando evento transacional. */
export const OPT_OUT_PAUSE_REASONS: ReadonlySet<string> = new Set([
  'optout_whatsapp',
  'revisao_possivel_optout',
])

export interface ClassifiableJob {
  jobType?: string | null
  massDispatchBatchId?: number | null
  upsellContent?: string | null
}

export interface ClassifiableLead {
  platform?: string | null
}

/** O job (empresa + plataforma do lead + jobType explícito) está na lista de permissão? */
export function isPauseBypassAllowed(
  job: { jobType?: string | null },
  lead: ClassifiableLead,
  companySlug: string | null | undefined,
): boolean {
  const jobType = job.jobType ?? null
  if (!jobType || !companySlug || !lead.platform) return false
  return TRANSACTIONAL_BYPASS_ALLOWLIST.some(rule =>
    rule.companySlug === companySlug && rule.platform === lead.platform && rule.jobTypes.includes(jobType))
}

export function classifyMessageJob(
  job: ClassifiableJob,
  lead: ClassifiableLead,
  companySlug: string | null | undefined,
): MessageJobClass {
  if (job.massDispatchBatchId != null) return 'promotional'
  if (job.upsellContent) return 'promotional'
  if (isPauseBypassAllowed(job, lead, companySlug)) return 'transactional'
  if (job.jobType && CONVERSATIONAL_JOB_TYPES.has(job.jobType)) return 'conversational'
  return 'promotional'
}

/** A pausa (lead/canal/geral/chave) bloqueia este job? Só o transacional da lista escapa. */
export function pauseAppliesToJob(jobClass: MessageJobClass): boolean {
  return jobClass !== 'transactional'
}

type PauseState = {
  botPaused?: boolean | null
  botPausedBy?: string | null
  botPausedAll?: boolean | null
  botPausedChannel?: string | null
}

/** Lead pausado por pedido de parar do cliente: bloqueia até o job transacional. */
export function isOptOutPause(lead: PauseState): boolean {
  return lead.botPaused === true && lead.botPausedBy != null && OPT_OUT_PAUSE_REASONS.has(lead.botPausedBy)
}

/**
 * Pausa gerada pela chave/"Pausar tudo"/"Pausar canal" (ou herdada por lead
 * novo sob a chave), a única que o bypass transacional ignora. Pausa
 * individual de atendente (humano assumiu), tag pessoa e anti-loop NÃO são
 * dessa origem e continuam bloqueando.
 */
export function isSwitchGeneratedPause(lead: PauseState): boolean {
  if (lead.botPaused !== true) return false
  if (isOptOutPause(lead)) return false
  return lead.botPausedAll === true
    || (lead.botPausedChannel != null && lead.botPausedChannel !== '')
    || (lead.botPausedBy != null && lead.botPausedBy.startsWith('auto (pausa geral'))
    || (lead.botPausedBy != null && lead.botPausedBy.startsWith('auto (canal '))
}

/** Pausa do lead que NENHUM job (nem o transacional) pode ignorar: opt-out ou pausa individual. */
export function isHardLeadPause(lead: PauseState): boolean {
  return lead.botPaused === true && !isSwitchGeneratedPause(lead)
}
