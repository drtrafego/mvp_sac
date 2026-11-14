/** Empresas cuja resposta a Story precisa permanecer fail-closed. */
export const STORY_PROTECTED_SLUGS = ['isabela-fanini'] as const

/** @deprecated O gatilho está disponível para todas as empresas com slug. */
export const STORY_TRIGGER_ENABLED_SLUGS = STORY_PROTECTED_SLUGS

export function isStoryTriggerEnabledForSlug(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && slug.trim().length > 0
}

export function isStoryProtectedForSlug(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && STORY_PROTECTED_SLUGS.includes(slug as typeof STORY_PROTECTED_SLUGS[number])
}

/** PostgreSQL text[] literal, kept as one bound parameter and cast at the SQL site. */
export function postgresTextArrayLiteral(values: readonly string[]): string {
  return `{${values.map(value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
}
