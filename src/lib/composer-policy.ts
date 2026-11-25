import { renderMetaTemplate } from '@/lib/meta-template-utils'
import { extractTemplateVariableKeys, templateVariableMapKey } from '@/lib/lead-template-variables'
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
  const keys = extractTemplateVariableKeys(body?.text ?? '')
  const numericKeys = keys.filter(key => /^variavel_\d+$/.test(key))
  const namedKeys = keys.filter(key => !/^variavel_\d+$/.test(key))
  const maxNumericIndex = numericKeys.reduce((max, key) => Math.max(max, Number(templateVariableMapKey(key))), 0)
  const readValue = (key: string) => {
    const direct = variables[key]
    const normalized = variables[templateVariableMapKey(key)]
    return typeof direct === 'string' ? direct.trim() : typeof normalized === 'string' ? normalized.trim() : ''
  }
  const values = Array.from({ length: maxNumericIndex }, (_, position) => readValue('variavel_' + (position + 1)))
    .concat(namedKeys.map(readValue))
  const orderedKeys = Array.from({ length: maxNumericIndex }, (_, position) => 'variavel_' + (position + 1)).concat(namedKeys)
  return {
    values,
    names: orderedKeys.map(key => key.startsWith('variavel_') ? undefined : key),
    missing: keys.filter(key => !readValue(key)),
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
