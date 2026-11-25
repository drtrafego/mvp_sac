import { renderMetaTemplate } from '@/lib/meta-template-utils'
import type { MetaTemplate } from '@/lib/whatsapp/meta'

export type ComposerChannel = 'whatsapp' | 'instagram' | 'email'

export function findApprovedMetaTemplate(
  templates: MetaTemplate[],
  name: string,
  language: string,
): MetaTemplate | null {
  return templates.find(template =>
    template.status === 'APPROVED'
      && template.name === name
      && template.language === language
  ) ?? null
}

export function readTemplateVariableValues(
  components: unknown[],
  variables: Record<string, unknown>,
): { values: string[]; names: Array<string | undefined>; missing: string[] } {
  const body = components.find(component => (
    component !== null
      && typeof component === 'object'
      && !Array.isArray(component)
      && String((component as { type?: unknown }).type ?? '').toUpperCase() === 'BODY'
      && typeof (component as { text?: unknown }).text === 'string'
  )) as { text: string } | undefined
  const keys: string[] = []
  for (const match of (body?.text ?? '').matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const raw = match[1].trim()
    const key = /^\d+$/.test(raw) ? `variavel_${Number(raw)}` : raw
    if (key && !keys.includes(key)) keys.push(key)
  }
  const values = keys.map(key => {
    const numeric = key.startsWith('variavel_') ? key.slice('variavel_'.length) : ''
    const direct = variables[key]
    const numericValue = numeric ? variables[numeric] : undefined
    return typeof direct === 'string' ? direct.trim() : typeof numericValue === 'string' ? numericValue.trim() : ''
  })
  return {
    values,
    names: keys.map(key => key.startsWith('variavel_') ? undefined : key),
    missing: keys.filter((_key, position) => !values[position]),
  }
}

export function renderApprovedMetaTemplate(
  template: MetaTemplate,
  variables: Record<string, unknown>,
): { content: string; values: string[]; names: Array<string | undefined>; missing: string[] } {
  const { values, names, missing } = readTemplateVariableValues(template.components ?? [], variables)
  const rendered = renderMetaTemplate(template.components ?? [], values, names)
  return { content: rendered.content, values, names, missing: Array.from(new Set(missing)) }
}

export function canUseSacReply(channel: ComposerChannel, requiresTemplate: boolean): boolean {
  return channel !== 'whatsapp' || !requiresTemplate
}
