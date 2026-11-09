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

export type TemplateHeaderDocument = { link: string; filename: string }

export function hasDocumentHeader(components: unknown[]): boolean {
  return components.some(value => {
    const component = asComponent(value)
    return componentType(component ?? {}) === 'HEADER'
      && typeof component?.format === 'string'
      && component.format.toUpperCase() === 'DOCUMENT'
  })
}

export function templateHeaderDocument(snapshot: unknown): TemplateHeaderDocument | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null
  const value = (snapshot as { headerDocument?: unknown }).headerDocument
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { link, filename } = value as { link?: unknown; filename?: unknown }
  return typeof link === 'string' && link.trim() && typeof filename === 'string' && filename.trim()
    ? { link, filename }
    : null
}

export function hasUnsupportedDynamicComponents(components: unknown[], options?: { allowDocumentHeader?: boolean }): boolean {
  return components.some(value => {
    const component = asComponent(value)
    if (!component) return false
    const type = componentType(component)
    if (type === 'BUTTON' || type === 'BUTTONS') return containsPlaceholder(component)
    if (type === 'HEADER') {
      const format = typeof component.format === 'string' ? component.format.toUpperCase() : ''
      if (format === 'DOCUMENT') return !options?.allowDocumentHeader
      if (format === 'IMAGE' || format === 'VIDEO' || format === 'LOCATION') return true
      return containsPlaceholder(component)
    }
    return false
  })
}

export function metaTemplateKey(name: string, language: string): string {
  return `${name}::${language}`
}

function textComponent(components: unknown[], type: string): string {
  for (const value of components) {
    const component = asComponent(value)
    if (component && componentType(component) === type && typeof component.text === 'string') {
      return component.text
    }
  }
  return ''
}

function buttonLabels(components: unknown[]): string[] {
  const labels: string[] = []
  for (const value of components) {
    const component = asComponent(value)
    if (!component || componentType(component) !== 'BUTTONS' || !Array.isArray(component.buttons)) continue
    for (const button of component.buttons) {
      const candidate = asComponent(button)
      if (candidate && typeof candidate.text === 'string' && candidate.text.trim()) labels.push(candidate.text)
    }
  }
  return labels
}

function substituteTemplateVariables(text: string, values: readonly string[], variableNames?: readonly string[]): string {
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_placeholder, rawKey: string) => {
    const numericIndex = Number(rawKey)
    const namedIndex = variableNames?.indexOf(rawKey) ?? -1
    const value = Number.isInteger(numericIndex) && numericIndex > 0
      ? values[numericIndex - 1]
      : namedIndex >= 0 ? values[namedIndex] : undefined
    return value ?? ''
  })
}

export function renderMetaTemplate(components: unknown, variableValues: readonly string[] = [], variableNames?: readonly string[]): {
  content: string
  complete: boolean
} {
  if (!Array.isArray(components)) return { content: '', complete: false }
  const body = textComponent(components, 'BODY')
  if (!body) return { content: '', complete: false }
  const header = components.map(asComponent).find(component => componentType(component ?? {}) === 'HEADER')
  if (header && typeof header.text !== 'string') return { content: '', complete: false }

  const sections = [
    textComponent(components, 'HEADER'),
    body,
    textComponent(components, 'FOOTER'),
    ...buttonLabels(components),
  ].map(section => substituteTemplateVariables(section, variableValues, variableNames)).filter(Boolean)

  return { content: sections.join('\n\n'), complete: true }
}

export function renderMetaTemplateBody(body: string, variableValues: readonly string[] = [], variableNames?: readonly string[]): string {
  return substituteTemplateVariables(body, variableValues, variableNames)
}

export function buildCanonicalSnapshot(template: MetaTemplate, options?: { headerDocument?: TemplateHeaderDocument }) {
  return {
    name: template.name,
    language: template.language,
    category: template.category,
    bodyText: bodyText(template.components ?? []),
    bodyVariableIndexes: extractBodyPlaceholders(template.components ?? []),
    components: structuredClone(template.components ?? []),
    ...(options?.headerDocument ? { headerDocument: structuredClone(options.headerDocument) } : {}),
  }
}
