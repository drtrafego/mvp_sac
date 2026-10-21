export type InstagramInboxPlacement = 'general' | 'exclusive'

export function isInstagramInboxPlacement(value: unknown): value is InstagramInboxPlacement {
  return value === 'general' || value === 'exclusive'
}

/**
 * Valores antigos ou ausentes mantêm o comportamento que já estava em
 * produção, com o Direct também na caixa geral.
 */
export function includesInstagramInGeneral(value: unknown): boolean {
  return value !== 'exclusive'
}
