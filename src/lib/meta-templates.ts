import { listMetaTemplates, type MetaTemplate } from '@/lib/whatsapp/meta'

export interface MetaTemplateSettings {
  whatsappProvider?: string | null
  metaWabaId?: string | null
  metaAccessToken?: string | null
}

export interface ApprovedMetaTemplate {
  nome: string
  categoria: string
  idioma: string
  status: 'APPROVED'
  corpo: string
  variaveis: string[]
}

export type MetaTemplatesState =
  | { kind: 'disabled'; templates: ApprovedMetaTemplate[]; message: string }
  | { kind: 'missing_config'; templates: ApprovedMetaTemplate[]; message: string }
  | { kind: 'empty'; templates: ApprovedMetaTemplate[]; message: string }
  | { kind: 'error'; templates: ApprovedMetaTemplate[]; message: string }
  | { kind: 'ready'; templates: ApprovedMetaTemplate[]; message: null }

type TemplateFetcher = (wabaId: string, accessToken: string) => Promise<MetaTemplate[]>

export function normalizeWhatsappProvider(provider: string | null | undefined): string {
  return provider?.trim() || 'meta'
}

function readBodyText(components: unknown[]): string {
  for (const component of components) {
    if (!component || typeof component !== 'object') continue
    const entry = component as { type?: unknown; text?: unknown }
    if (String(entry.type ?? '').toUpperCase() === 'BODY' && typeof entry.text === 'string') {
      return entry.text
    }
  }
  return ''
}

function extractVariables(body: string): string[] {
  const indexes = new Set<number>()
  for (const match of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    indexes.add(Number(match[1]))
  }
  return Array.from(indexes)
    .sort((a, b) => a - b)
    .map(index => `variavel_${index}`)
}

export function toApprovedMetaTemplate(template: MetaTemplate): ApprovedMetaTemplate | null {
  if (template.status !== 'APPROVED') return null

  const corpo = readBodyText(template.components ?? [])
  return {
    nome: template.name,
    categoria: template.category,
    idioma: template.language,
    status: 'APPROVED',
    corpo,
    variaveis: extractVariables(corpo),
  }
}

function redactMessage(message: string, accessToken: string): string {
  return accessToken ? message.replaceAll(accessToken, '[token-redigido]') : message
}

export async function loadApprovedMetaTemplates(
  settings: MetaTemplateSettings | null | undefined,
  fetchTemplates: TemplateFetcher = listMetaTemplates,
): Promise<MetaTemplatesState> {
  const provider = normalizeWhatsappProvider(settings?.whatsappProvider)
  if (provider !== 'meta') {
    return {
      kind: 'disabled',
      templates: [],
      message: 'WhatsApp Meta Cloud API não está ativo para esta empresa.',
    }
  }

  if (!settings?.metaWabaId || !settings?.metaAccessToken) {
    return {
      kind: 'missing_config',
      templates: [],
      message: 'Configure o WABA ID e o Access Token Meta primeiro.',
    }
  }

  try {
    const templates = (await fetchTemplates(settings.metaWabaId, settings.metaAccessToken))
      .map(toApprovedMetaTemplate)
      .filter((template): template is ApprovedMetaTemplate => Boolean(template))
      .sort((a, b) => `${a.nome}:${a.idioma}`.localeCompare(`${b.nome}:${b.idioma}`))

    if (templates.length === 0) {
      return {
        kind: 'empty',
        templates,
        message: 'A Meta respondeu sem templates APPROVED para esta WABA.',
      }
    }

    return { kind: 'ready', templates, message: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Não foi possível buscar os templates aprovados na Meta.'
    return {
      kind: 'error',
      templates: [],
      message: redactMessage(message, settings.metaAccessToken),
    }
  }
}
