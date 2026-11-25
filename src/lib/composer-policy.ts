import { extractBodyPlaceholders, renderMetaTemplate } from '@/lib/meta-template-utils'
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
): { values: string[]; missing: number[] } {
  const indexes = extractBodyPlaceholders(components)
  const values = indexes.map(index => {
    const direct = variables[String(index)]
    const named = variables[`variavel_${index}`]
    return typeof direct === 'string' ? direct.trim() : typeof named === 'string' ? named.trim() : ''
  })
  return {
    values,
    missing: indexes.filter((_index, position) => !values[position]),
  }
}

export function renderApprovedMetaTemplate(
  template: MetaTemplate,
  variables: Record<string, unknown>,
): { content: string; values: string[]; missing: number[] } {
  const { values, missing } = readTemplateVariableValues(template.components ?? [], variables)
  const rendered = renderMetaTemplate(template.components ?? [], values)
  const unresolved = rendered.complete ? missing : [...missing, ...extractBodyPlaceholders(template.components ?? [])]
  return { content: rendered.content, values, missing: Array.from(new Set(unresolved)) }
}

export function canUseSacReply(channel: ComposerChannel, requiresTemplate: boolean): boolean {
  return channel !== 'whatsapp' || !requiresTemplate
}
