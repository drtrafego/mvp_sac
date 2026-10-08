/**
 * Funil Cursos - Isabela Fanini (Bela)
 * 
 * Regras de Negócio e Estados do Funil do produto "Despertar das Bellas".
 * 
 * Gatilho:
 *   - Empresa: isabela-fanini
 *   - Plataforma: Kiwify
 *   - Evento: compra_aprovada
 *   - Produto: Despertar das Bellas (ID real ou nome exato)
 *   - transactionId único (impede duplicidade)
 *   - NÃO inicia para leads importados como "atendimento" ou apenas com tag "comproudesafio".
 * 
 * Agendamentos:
 *   - D+7 (10.080 minutos) a partir de approvedDate (fuso America/Sao_Paulo):
 *     "Oi, {nome}! 💛 Passei para saber como você está com o Despertar das Bellas. Você já conseguiu começar?"
 *   - D+15 (21.600 minutos) a partir de approvedDate (fuso America/Sao_Paulo):
 *     "Oi, {nome}! 💛 Agora que você teve um tempo para viver o Despertar, queria muito saber: o que você achou dessa jornada?"
 * 
 * Contexto Injetado:
 *   [FUNIL_CURSOS] com campos mínimos obrigatórios.
 */

export const FUNIL_CURSOS_COMPANY_SLUG = 'isabela-fanini'
export const FUNIL_CURSOS_NAME = 'funil_cursos'
export const FUNIL_CURSOS_PRODUCT_NAME = 'Despertar das Bellas'

export const D7_DELAY_MINUTES = 10080  // 7 dias
export const D15_DELAY_MINUTES = 21600 // 15 dias

export const D7_TEMPLATE = 'Oi, {nome}! 💛 Passei para saber como você está com o Despertar das Bellas. Você já conseguiu começar?'
export const D15_TEMPLATE = 'Oi, {nome}! 💛 Agora que você teve um tempo para viver o Despertar, queria muito saber: o que você achou dessa jornada?'

export type FunnelStage =
  | 'compra_aprovada'
  | 'd7_pendente'
  | 'd7_comecou'
  | 'd7_nao_comecou'
  | 'd7_com_dificuldade'
  | 'd15_pendente'
  | 'd15_avaliacao_positiva'
  | 'd15_avaliacao_negativa'
  | 'portal_com_abertura'
  | 'sem_interesse'
  | 'humano'
  | 'pausado'

export interface FunilCursosState {
  funnel_name: 'funil_cursos'
  stage: FunnelStage
  purchase_id: string
  product_name: string
  purchase_approved_at: string // ISO string
  timezone: 'America/Sao_Paulo'
  attempt: number
  last_user_reply: string
  started_status: 'comecou' | 'nao_comecou' | 'com_dificuldade' | ''
  difficulty_status: string
  experience_status: 'positiva' | 'negativa' | ''
  portal_interest: 'abertura' | 'sem_interesse' | 'ja_comprou' | ''
  portal_already_bought: boolean
  pause_reason: string
  human_takeover: boolean
}

/**
 * Normaliza texto para comparações semânticas.
 */
function normalizeText(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
}

/**
 * Verifica se o produto corresponde ao "Despertar das Bellas".
 */
export function isDespertarDasBellas(productName?: string | null, productId?: string | null): boolean {
  if (!productName && !productId) return false
  const norm = normalizeText(productName)
  if (norm.includes('despertar das bella') || norm.includes('despertar das bela')) return true
  if (norm === 'despertar' || norm.startsWith('despertar -') || norm.startsWith('despertar:')) return true
  return false
}

/**
 * Validação estrita do gatilho do Funil Cursos.
 * 
 * Regras:
 *  - empresa: isabela-fanini
 *  - plataforma: kiwify
 *  - evento: compra_aprovada
 *  - produto: Despertar das Bellas
 *  - transactionId obrigatório (evita duplicatas)
 *  - Exclui expressamente leads de "atendimento", "import_planilha" ou que apenas tenham a tag "comproudesafio".
 */
export function isFunilCursosTrigger(lead: {
  companySlug?: string | null
  platform?: string | null
  eventType?: string | null
  productName?: string | null
  productId?: string | null
  transactionId?: string | null
  tags?: string[] | null
}): boolean {
  if (!lead.companySlug || lead.companySlug.trim().toLowerCase() !== FUNIL_CURSOS_COMPANY_SLUG) {
    return false
  }

  // Plataforma Kiwify obrigatória
  const plat = (lead.platform ?? '').trim().toLowerCase()
  if (plat !== 'kiwify') {
    return false
  }

  // Evento compra_aprovada obrigatório
  const evt = (lead.eventType ?? '').trim().toLowerCase()
  if (evt !== 'compra_aprovada') {
    return false
  }

  // transactionId obrigatório para garantir rastreabilidade de compra real
  if (!lead.transactionId || lead.transactionId.trim() === '') {
    return false
  }

  // Produto deve ser Despertar das Bellas
  if (!isDespertarDasBellas(lead.productName, lead.productId)) {
    return false
  }

  return true
}

/**
 * Cria o estado inicial do Funil Cursos após a confirmação da compra aprovada.
 */
export function createInitialFunilCursosState(params: {
  transactionId: string
  productName?: string | null
  approvedDate?: Date | string | null
  portalAlreadyBought?: boolean
}): FunilCursosState {
  const approvedAt = params.approvedDate
    ? new Date(params.approvedDate).toISOString()
    : new Date().toISOString()

  return {
    funnel_name: 'funil_cursos',
    stage: 'd7_pendente',
    purchase_id: params.transactionId,
    product_name: params.productName || FUNIL_CURSOS_PRODUCT_NAME,
    purchase_approved_at: approvedAt,
    timezone: 'America/Sao_Paulo',
    attempt: 1,
    last_user_reply: '',
    started_status: '',
    difficulty_status: '',
    experience_status: '',
    portal_interest: params.portalAlreadyBought ? 'ja_comprou' : '',
    portal_already_bought: !!params.portalAlreadyBought,
    pause_reason: '',
    human_takeover: false,
  }
}

/**
 * Calcula os agendamentos D+7 e D+15 em minutos a partir de approvedDate.
 */
export function calculateFunilCursosSchedules(approvedDate: Date | string) {
  const baseDate = new Date(approvedDate)
  const d7Date = new Date(baseDate.getTime() + D7_DELAY_MINUTES * 60 * 1000)
  const d15Date = new Date(baseDate.getTime() + D15_DELAY_MINUTES * 60 * 1000)

  return {
    d7: {
      delayMinutes: D7_DELAY_MINUTES,
      scheduledFor: d7Date,
      template: D7_TEMPLATE,
      order: 7,
    },
    d15: {
      delayMinutes: D15_DELAY_MINUTES,
      scheduledFor: d15Date,
      template: D15_TEMPLATE,
      order: 15,
    },
  }
}

/**
 * Formata o bloco [FUNIL_CURSOS] para injeção no contexto do bot.
 */
export function formatFunilCursosContext(state: FunilCursosState): string {
  return [
    '[FUNIL_CURSOS]',
    `funnel_name=${state.funnel_name}`,
    `stage=${state.stage}`,
    `purchase_id=${state.purchase_id}`,
    `product_name=${state.product_name}`,
    `purchase_approved_at=${state.purchase_approved_at}`,
    `timezone=${state.timezone}`,
    `attempt=${state.attempt}`,
    `last_user_reply=${state.last_user_reply.replace(/\n/g, ' ')}`,
    `started_status=${state.started_status}`,
    `difficulty_status=${state.difficulty_status}`,
    `experience_status=${state.experience_status}`,
    `portal_interest=${state.portal_interest}`,
    `portal_already_bought=${state.portal_already_bought ? 'true' : 'false'}`,
    `pause_reason=${state.pause_reason}`,
    `human_takeover=${state.human_takeover ? 'true' : 'false'}`,
  ].join('\n')
}

// ─── Análise de Intenção do Usuário ──────────────────────────────────────────

const STOP_PATTERNS = [
  'pare',
  'parar',
  'para de mandar',
  'nao mande mais',
  'nao me mande',
  'sair',
  'descadastrar',
  'cancelar',
  'stop',
  'chega',
  'nao quero receber',
  'favor nao enviar',
]

const DIFFICULTY_PATTERNS = [
  'nao consigo acessar',
  'nao estou conseguindo acessar',
  'problema de acesso',
  'nao recebi o acesso',
  'onde acesso',
  'perdi a senha',
  'esqueci a senha',
  'nao abre',
  'deu erro',
  'ta dando erro',
  'dificuldade',
  'muito dificil',
  'bloqueado',
  'nao entra',
]

const STARTED_PATTERNS = [
  'sim',
  'ja comecei',
  'comecei',
  'ja sim',
  'consegui sim',
  'estou fazendo',
  'to fazendo',
  'comecei ontem',
  'ja assisti',
  'to assistindo',
  'ja fiz',
  'consegui comecar',
]

const NOT_STARTED_PATTERNS = [
  'ainda nao',
  'nao comecei',
  'nao consegui',
  'correria',
  'sem tempo',
  'nao tive tempo',
  'ainda nada',
  'vou comecar',
  'nao tive como',
]

const POSITIVE_EXPERIENCE_PATTERNS = [
  'amei',
  'adorei',
  'maravilhoso',
  'maravilhosa',
  'muito bom',
  'muito boa',
  'otimo',
  'otima',
  'gostei muito',
  'incrivel',
  'transformador',
  'transformadora',
  'sensacional',
  'perfeito',
  'perfeita',
  'excelente',
  'ajudou muito',
  'valeu muito',
  'super positiva',
]

const NEGATIVE_EXPERIENCE_PATTERNS = [
  'nao gostei',
  'odiei',
  'ruim',
  'pessimo',
  'pessima',
  'nao achei bom',
  'decepcionada',
  'decepcionado',
  'nao valeu a pena',
  'fraco',
  'muito basico',
  'nao me ajudou',
  'desisti',
  'chato',
  'chata',
]

const PORTAL_INTEREST_PATTERNS = [
  'quero continuar',
  'quero saber mais',
  'como funciona',
  'me explica',
  'qual o proximo passo',
  'como faco para continuar',
  'como faco pra continuar',
  'tenho interesse',
  'quero sim continuar',
  'me conta mais',
  'quanto custa o portal',
  'como faco pra entrar no portal',
  'quero entrar no portal',
]

const VAGUE_PATTERNS = [
  'ok',
  'legal',
  'depois vejo',
  'depois eu vejo',
  'vou ver',
  'depois te falo',
  'talvez',
  'mais tarde',
  'depois',
  'beleza',
  'ta',
  'joinha',
  '👍',
]

/**
 * Avalia a transição de estado com base na resposta do usuário e nas regras de negócio.
 */
export function evaluateFunilTransition(
  currentState: FunilCursosState,
  userReply: string,
  options?: {
    humanTakeover?: boolean
    portalAlreadyBought?: boolean
  }
): FunilCursosState {
  const next: FunilCursosState = {
    ...currentState,
    attempt: currentState.attempt + 1,
    last_user_reply: userReply.trim(),
  }

  // 1. Atendimento humano prioritário
  if (options?.humanTakeover || currentState.human_takeover) {
    next.stage = 'humano'
    next.human_takeover = true
    return next
  }

  // 2. Se o usuário já comprou o Portal
  if (options?.portalAlreadyBought || currentState.portal_already_bought) {
    next.portal_already_bought = true
    next.portal_interest = 'ja_comprou'
  }

  const norm = normalizeText(userReply)

  // 3. Pedido de parada / opt-out imediato
  if (STOP_PATTERNS.some(p => norm.includes(p))) {
    next.stage = 'pausado'
    next.pause_reason = 'pedido_do_usuario'
    return next
  }

  // 4. Se a resposta for vazia / silêncio, não deduz intenção nem altera stage
  if (!norm) {
    return next
  }

  // 5. Avaliação do estágio atual
  switch (currentState.stage) {
    case 'compra_aprovada':
    case 'd7_pendente': {
      // Prioridade 1 no D+7: Dificuldade / Problema de acesso
      if (DIFFICULTY_PATTERNS.some(p => norm.includes(p))) {
        next.stage = 'd7_com_dificuldade'
        next.started_status = 'com_dificuldade'
        next.difficulty_status = 'relatou_dificuldade'
        return next
      }

      // Prioridade 2 no D+7: Não começou
      if (NOT_STARTED_PATTERNS.some(p => norm.includes(p))) {
        next.stage = 'd7_nao_comecou'
        next.started_status = 'nao_comecou'
        return next
      }

      // Prioridade 3 no D+7: Começou
      if (STARTED_PATTERNS.some(p => norm.includes(p))) {
        next.stage = 'd7_comecou'
        next.started_status = 'comecou'
        return next
      }

      // Se for vaga ou ambígua, não assume que começou nem oferece Portal
      break
    }

    case 'd7_comecou':
    case 'd7_nao_comecou':
    case 'd7_com_dificuldade':
    case 'd15_pendente': {
      // D+15: Ouvir avaliação

      // Avaliação negativa
      if (NEGATIVE_EXPERIENCE_PATTERNS.some(p => norm.includes(p))) {
        next.stage = 'd15_avaliacao_negativa'
        next.experience_status = 'negativa'
        next.portal_interest = 'sem_interesse'
        return next
      }

      // Avaliação positiva
      if (POSITIVE_EXPERIENCE_PATTERNS.some(p => norm.includes(p))) {
        next.stage = 'd15_avaliacao_positiva'
        next.experience_status = 'positiva'
        return next
      }

      // Respostas vagas ("ok", "vou ver", "depois vejo") NÃO são interesse
      if (VAGUE_PATTERNS.some(p => norm.includes(p))) {
        next.portal_interest = 'sem_interesse'
        return next
      }
      break
    }

    case 'd15_avaliacao_positiva': {
      // Se já comprou o Portal, não pode haver oferta
      if (next.portal_already_bought) {
        next.portal_interest = 'ja_comprou'
        return next
      }

      // Interesse explícito no Portal
      if (PORTAL_INTEREST_PATTERNS.some(p => norm.includes(p))) {
        next.stage = 'portal_com_abertura'
        next.portal_interest = 'abertura'
        return next
      }

      // Silêncio, "depois vejo", resposta vaga
      if (VAGUE_PATTERNS.some(p => norm.includes(p))) {
        next.stage = 'sem_interesse'
        next.portal_interest = 'sem_interesse'
        return next
      }

      // Negativa explícita
      if (norm.includes('nao quero') || norm.includes('nao tenho interesse') || norm.includes('agora nao')) {
        next.stage = 'sem_interesse'
        next.portal_interest = 'sem_interesse'
        return next
      }
      break
    }

    default:
      break
  }

  return next
}

/**
 * Valida se o Portal PODE ser oferecido neste momento.
 * 
 * Regra:
 * NÃO oferecer se:
 *   - a pessoa já comprou o Portal;
 *   - pediu para parar (pausado);
 *   - está insatisfeita (d15_avaliacao_negativa);
 *   - está relatando dificuldade ou problema de acesso (d7_com_dificuldade);
 *   - houve atendimento humano (humano);
 *   - não há abertura clara do cliente.
 */
export function canOfferPortal(state: FunilCursosState): boolean {
  if (state.portal_already_bought) return false
  if (state.human_takeover || state.stage === 'humano') return false
  if (state.stage === 'pausado' || state.pause_reason) return false
  if (state.stage === 'd7_com_dificuldade' || state.difficulty_status) return false
  if (state.stage === 'd15_avaliacao_negativa' || state.experience_status === 'negativa') return false
  if (state.stage === 'sem_interesse' || state.portal_interest === 'sem_interesse') return false

  // Só oferece se estiver explicitamente em portal_com_abertura
  return state.stage === 'portal_com_abertura' && state.portal_interest === 'abertura'
}
