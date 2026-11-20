import {
  GABI_AGENT_SLUG,
  GABI_COMPANY_SLUG,
  isGabiCompany,
  mirrorGabiLeadPause,
  syncGabiGlobalPause,
  type GabiMirrorResult,
} from '@/lib/gabi-pause-mirror'

/** Empresa que possui um agente no banco central dos bots. */
export type CentralPauseCompany = { id: number; slug: string }

export interface CentralBotPauseInput {
  company: CentralPauseCompany
  paused: boolean
  by?: string | null
  phone?: string | null
  channel?: string | null
  leadId?: number | null
  global?: boolean
}

export interface CentralBotPauseResult extends GabiMirrorResult {
  /** Aviso compatível com as rotas antigas do painel. */
  warning?: string
}

/** Mapeamento explícito: nenhuma outra empresa escreve no banco central. */
export function centralAgentForCompany(company: { slug: string }): string | null {
  return isGabiCompany(company.slug) ? GABI_AGENT_SLUG : null
}

/** A ponte usa o chat_id como dígitos; o SAC não inventa DDI. */
export function centralChatId(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits || null
}

function failureWarning(): string {
  return 'A alteração foi gravada no SAC, mas não chegou ao bot central. Tente novamente; o painel continua operando localmente.'
}

/**
 * Propaga o estado já gravado localmente para o agente central.
 *
 * A implementação efetiva fica no espelho existente porque ele contém as
 * travas de autoria e de formatos de telefone. Em particular, uma retomada
 * individual remove apenas a linha `sac:` correspondente; nunca grava
 * `paused=false` em `agent_chat_pause`, que apagaria uma pausa do dono/bot.
 * Erros do banco central são convertidos em resultado, nunca lançados.
 */
export async function propagateCentralBotPause(input: CentralBotPauseInput): Promise<CentralBotPauseResult> {
  if (!centralAgentForCompany(input.company)) return { ok: true, skipped: 'empresa sem agente central' }

  let result: GabiMirrorResult
  try {
    result = input.global
      ? await syncGabiGlobalPause(input.company)
      : await mirrorGabiLeadPause({
          company: input.company,
          channel: input.channel ?? 'whatsapp',
          phone: input.phone,
          paused: input.paused,
          by: input.by,
          leadId: input.leadId,
        })
  } catch (error) {
    console.error('[SAC central pause] falha ao propagar estado:', error instanceof Error ? error.message : error)
    return { ok: false, warning: failureWarning() }
  }

  return result.ok ? result : { ...result, warning: failureWarning() }
}

export const CENTRAL_PAUSE_COMPANY_SLUG = GABI_COMPANY_SLUG
