import { SacInputError } from '@/lib/sac-access'

const TYPES = new Set(['HEADER', 'BODY', 'FOOTER', 'BUTTONS'])
const BUTTON_TYPES = new Set(['QUICK_REPLY', 'URL', 'PHONE_NUMBER'])

type TemplateComponent = { type: string; text?: string; format?: string; buttons?: unknown[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function requireOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new SacInputError(`${label} contém propriedade não suportada.`)
  }
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function validateSequentialVariables(text: string, label: string) {
  const variables = Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g), match => Number(match[1]))
  if (variables.length === 0) return
  const unique = [...new Set(variables)].sort((a, b) => a - b)
  if (unique.some((value, index) => value !== index + 1)) {
    throw new SacInputError(`${label} precisa usar variáveis sequenciais, começando em {{1}}.`)
  }
}

export function validateMetaTemplateComponents(value: unknown): TemplateComponent[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) throw new SacInputError('Inclua de um a quatro componentes Meta.')
  const components = value.map((component) => {
    if (!isRecord(component) || typeof component.type !== 'string' || !TYPES.has(component.type)) throw new SacInputError('Componente Meta inválido.')
    const allowedKeys = component.type === 'BUTTONS'
      ? ['type', 'buttons']
      : component.type === 'HEADER'
        ? ['type', 'text', 'format', 'example']
        : component.type === 'BODY'
          ? ['type', 'text', 'example']
          : ['type', 'text']
    requireOnlyKeys(component, allowedKeys, 'Componente Meta')
    if (component.text !== undefined && typeof component.text !== 'string') throw new SacInputError('Texto do componente inválido.')
    if (component.type === 'BODY' && (!component.text || component.text.trim().length > 1024)) throw new SacInputError('O componente BODY exige texto de até 1024 caracteres.')
    if ((component.type === 'HEADER' || component.type === 'FOOTER') && component.text !== undefined && component.text.length > 60) throw new SacInputError('HEADER e FOOTER aceitam no máximo 60 caracteres.')
    if ((component.type === 'BODY' || component.type === 'HEADER') && typeof component.text === 'string') validateSequentialVariables(component.text, component.type === 'BODY' ? 'O BODY' : 'O HEADER')
    if (component.type === 'BUTTONS') {
      if (!Array.isArray(component.buttons) || component.buttons.length === 0 || component.buttons.length > 3) throw new SacInputError('BUTTONS exige de um a três botões.')
      for (const button of component.buttons) {
        if (!isRecord(button) || typeof button.type !== 'string' || typeof button.text !== 'string' || !button.text.trim() || button.text.length > 20) throw new SacInputError('Botão Meta inválido.')
        requireOnlyKeys(button, ['type', 'text', 'url', 'phone_number', 'example'], 'Botão Meta')
        if (!BUTTON_TYPES.has(button.type)) throw new SacInputError('Tipo de botão Meta inválido.')
        if (button.type === 'QUICK_REPLY' && (button.url !== undefined || button.phone_number !== undefined || button.example !== undefined)) throw new SacInputError('Resposta rápida não aceita URL, telefone ou exemplo.')
        if (button.type === 'URL') {
          if (typeof button.url !== 'string' || !validUrl(button.url) || button.phone_number !== undefined || button.example !== undefined) throw new SacInputError('Botão URL exige uma URL HTTP(S) válida e não aceita telefone ou exemplo.')
        }
        if (button.type === 'PHONE_NUMBER') {
          if (typeof button.phone_number !== 'string' || !/^\+[1-9]\d{6,14}$/.test(button.phone_number) || button.url !== undefined || button.example !== undefined) throw new SacInputError('Botão de telefone exige número E.164 e não aceita URL ou exemplo.')
        }
      }
    }
    return component as TemplateComponent
  })
  if (components.filter(component => component.type === 'BODY').length !== 1) throw new SacInputError('O template precisa de exatamente um componente BODY.')
  if (new Set(components.map(component => component.type)).size !== components.length) throw new SacInputError('Não repita tipos de componente Meta.')
  return components
}
