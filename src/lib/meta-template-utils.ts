import type { MetaTemplate } from '@/lib/whatsapp/meta'

type TemplateComponent = Record<string, unknown>

function asComponent(value: unknown): TemplateComponent | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as TemplateComponent
    : null
}

function componentType(component: TemplateComponent): string {
  return typeof component.type === 'string' ? component.type.toUpperCase() : ''
}

function bodyText(components: unknown[]): string {
  for (const value of components) {
    const component = asComponent(value)
    if (component && componentType(component) === 'BODY' && typeof component.text === 'string') {
      return component.text
    }
  }
  return ''
}

function containsPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return /\{\{\s*\d+\s*\}\}/.test(value)
  if (Array.isArray(value)) return value.some(containsPlaceholder)
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsPlaceholder)
  return false
}

export function extractBodyPlaceholders(components: unknown[]): number[] {
  const indexes = new Set<number>()
  for (const match of bodyText(components).matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    indexes.add(Number(match[1]))
  }
  return [...indexes].sort((a, b) => a - b)
}

export function hasUnsupportedDynamicComponents(components: unknown[]): boolean {
  return components.some(value => {
    const component = asComponent(value)
    if (!component) return false
    const type = componentType(component)
    if (type === 'BUTTON' || type === 'BUTTONS') return containsPlaceholder(component)
    if (type === 'HEADER') {
      const format = typeof component.format === 'string' ? component.format.toUpperCase() : ''
      if (format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT' || format === 'LOCATION') return true
      return containsPlaceholder(component)
    }
    return false
  })
}

export function metaTemplateKey(name: string, language: string): string {
  return `${name}::${language}`
}

export function buildCanonicalSnapshot(template: MetaTemplate) {
  return {
    name: template.name,
    language: template.language,
    category: template.category,
    bodyText: bodyText(template.components ?? []),
    bodyVariableIndexes: extractBodyPlaceholders(template.components ?? []),
  }
}
