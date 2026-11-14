/**
 * Shared contract for the pilot. Adding an account later is intentionally a
 * one-line change here, so the UI, API and webhook cannot drift apart.
 */
export const STORY_TRIGGER_ENABLED_SLUGS = ['isabela-fanini'] as const

export function isStoryTriggerEnabledForSlug(slug: string | null | undefined): boolean {
  return typeof slug === 'string' && STORY_TRIGGER_ENABLED_SLUGS.includes(slug as typeof STORY_TRIGGER_ENABLED_SLUGS[number])
}

/** PostgreSQL text[] literal, kept as one bound parameter and cast at the SQL site. */
export function postgresTextArrayLiteral(values: readonly string[]): string {
  return `{${values.map(value => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
}
