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
 *   promotional    -> upsell, disparo em massa, outreach manual, qualquer job
 *                     que não prove ser evento de checkout: a pausa bloqueia
 *
 * Regra de dúvida: sem prova de origem de checkout, é promocional (bloqueado).
 */
export type MessageJobClass = 'transactional' | 'conversational' | 'promotional'

/** Jobs gravados pelos webhooks de checkout com jobType próprio. */
export const TRANSACTIONAL_JOB_TYPES: ReadonlySet<string> = new Set([
  'isabela_purchase_sequence', // funil pós-compra (boas-vindas, D+1, D+10)
  'boleto_followup_immediate', // boleto emitido (ISABELA_BOLETO_JOB_TYPE)
  'isabela_cartao_recusado', // cartão recusado
  'pix_followup_60m', // Pix não pago, 60 min (PIX_FOLLOWUP_JOB_TYPE)
])

/** Jobs que nascem da conversa/IA, não de um evento de checkout. */
export const CONVERSATIONAL_JOB_TYPES: ReadonlySet<string> = new Set([
  'isabela_portal_after_challenge', // agendado por scheduleIsabelaPortalTemplate (ai-reply.ts)
])

/** Plataformas de checkout cujos webhooks criam lead e job (recovery_leads.platform). */
export const CHECKOUT_EVENT_PLATFORMS: ReadonlySet<string> = new Set(['kiwify', 'hotmart', 'greenn', 'zouti'])

/** Eventos de checkout (recovery_leads.event_type) que disparam mensagem de evento. */
export const CHECKOUT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'compra_aprovada', 'boleto', 'pix', 'cartao_recusado', 'carrinho_abandonado',
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
  eventType?: string | null
}

export function classifyMessageJob(job: ClassifiableJob, lead: ClassifiableLead): MessageJobClass {
  if (job.massDispatchBatchId != null) return 'promotional'
  if (job.upsellContent) return 'promotional'
  const jobType = job.jobType ?? null
  if (jobType && TRANSACTIONAL_JOB_TYPES.has(jobType)) return 'transactional'
  if (jobType && CONVERSATIONAL_JOB_TYPES.has(jobType)) return 'conversational'
  // Job de sequência sem jobType (webhooks Hotmart/Greenn/Zouti/Kiwify de
  // outras empresas): só é de evento se o lead veio de checkout com evento de
  // checkout. Lead manual/importado com sequência disparada à mão não é.
  if (
    jobType == null
    && lead.platform
    && CHECKOUT_EVENT_PLATFORMS.has(lead.platform)
    && lead.eventType
    && CHECKOUT_EVENT_TYPES.has(lead.eventType)
  ) return 'transactional'
  return 'promotional'
}

/** A pausa (lead/canal/geral/chave) bloqueia este job? Só o transacional escapa. */
export function pauseAppliesToJob(jobClass: MessageJobClass): boolean {
  return jobClass !== 'transactional'
}

/** Lead pausado por pedido de parar do cliente: bloqueia até o job transacional. */
export function isOptOutPause(lead: { botPaused?: boolean | null; botPausedBy?: string | null }): boolean {
  return lead.botPaused === true && lead.botPausedBy != null && OPT_OUT_PAUSE_REASONS.has(lead.botPausedBy)
}
