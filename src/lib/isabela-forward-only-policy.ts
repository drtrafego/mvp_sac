/**
 * Ordem do Gastão (12/11/2026): a Isabela só dispara eventos da Kiwify que
 * ocorreram DE AGORA EM DIANTE; nada retroativo. O corte padrão é o instante em
 * que esta correção foi escrita (offset BRT explícito para não depender do
 * fuso do runtime). No deploy, ISABELA_FORWARD_ONLY_SINCE (ISO 8601 com
 * offset) sobrescreve o padrão com o momento exato da publicação. Variável
 * presente e inválida falha fechada (nada passa).
 */
export const ISABELA_FORWARD_ONLY_DEFAULT_CUTOFF_AT = new Date('2026-11-12T14:20:00-03:00')

const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

export function getIsabelaForwardOnlyCutoff(env: Record<string, string | undefined> = process.env): Date | null {
  const raw = env.ISABELA_FORWARD_ONLY_SINCE?.trim()
  if (!raw) return ISABELA_FORWARD_ONLY_DEFAULT_CUTOFF_AT
  // Só ISO 8601 completo com fuso explícito (Z ou ±hh:mm). "2026", "2026-11-12",
  // "0", "11/12/2026" ou ISO sem offset (que viraria UTC/fuso do runtime) NÃO valem.
  const match = ISO_WITH_OFFSET.exec(raw)
  if (!match) return null
  const [, y, mo, d, h, mi, sec] = match
  const month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(sec ?? 0)
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null
  // Rejeita dia inexistente (ex.: 2026-02-31, que o Date empurra para março).
  const calendar = new Date(Date.UTC(Number(y), month - 1, day))
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null
  return parsed
}

export type IsabelaForwardOnlyGate =
  | { allowed: true }
  | { allowed: false; reason: 'evento_isabela_anterior_ao_corte' | 'evento_isabela_sem_data_de_ocorrencia' | 'evento_isabela_corte_invalido' }

/**
 * Falha fechada: um replay sem timestamp de ocorrência não pode virar mensagem.
 * A data usada é a de OCORRÊNCIA do evento (approved_date/created_at do
 * payload), nunca a hora em que o webhook chegou ao SAC. Outras empresas não
 * usam esta política.
 */
export function evaluateIsabelaForwardOnlyEvent(
  companySlug: string | null | undefined,
  occurredAt: Date | null | undefined,
  env: Record<string, string | undefined> = process.env,
): IsabelaForwardOnlyGate {
  if (companySlug !== 'isabela-fanini') return { allowed: true }
  const cutoff = getIsabelaForwardOnlyCutoff(env)
  if (!cutoff) return { allowed: false, reason: 'evento_isabela_corte_invalido' }
  if (!(occurredAt instanceof Date) || Number.isNaN(occurredAt.getTime())) {
    return { allowed: false, reason: 'evento_isabela_sem_data_de_ocorrencia' }
  }
  if (occurredAt < cutoff) return { allowed: false, reason: 'evento_isabela_anterior_ao_corte' }
  return { allowed: true }
}
