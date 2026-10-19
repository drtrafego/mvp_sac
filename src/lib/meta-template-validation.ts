import { SacInputError } from '@/lib/sac-access'

const TYPES = new Set(['HEADER', 'BODY', 'FOOTER', 'BUTTONS'])

type TemplateComponent = { type: string; text?: string; format?: string; buttons?: unknown[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validateMetaTemplateComponents(value: unknown): TemplateComponent[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4) throw new SacInputError('Inclua de um a quatro componentes Meta.')
  const components = value.map((component) => {
    if (!isRecord(component) || typeof component.type !== 'string' || !TYPES.has(component.type)) throw new SacInputError('Componente Meta inválido.')
    if (component.text !== undefined && typeof component.text !== 'string') throw new SacInputError('Texto do componente inválido.')
    if (component.type === 'BODY' && (!component.text || component.text.trim().length > 1024)) throw new SacInputError('O componente BODY exige texto de até 1024 caracteres.')
    if ((component.type === 'HEADER' || component.type === 'FOOTER') && component.text !== undefined && component.text.length > 60) throw new SacInputError('HEADER e FOOTER aceitam no máximo 60 caracteres.')
    if (component.type === 'BUTTONS') {
      if (!Array.isArray(component.buttons) || component.buttons.length === 0 || component.buttons.length > 3) throw new SacInputError('BUTTONS exige de um a três botões.')
      for (const button of component.buttons) {
        if (!isRecord(button) || typeof button.type !== 'string' || typeof button.text !== 'string' || !button.text.trim() || button.text.length > 20) throw new SacInputError('Botão Meta inválido.')
      }
    }
    return component as TemplateComponent
  })
  if (components.filter(component => component.type === 'BODY').length !== 1) throw new SacInputError('O template precisa de exatamente um componente BODY.')
  if (new Set(components.map(component => component.type)).size !== components.length) throw new SacInputError('Não repita tipos de componente Meta.')
  return components
}
