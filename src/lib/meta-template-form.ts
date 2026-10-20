export type MetaHeaderType = 'none' | 'text' | 'image' | 'video' | 'document'
export type MetaButtonType = 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'

export interface MetaTemplateFormButton {
  type: MetaButtonType
  text: string
  value: string
}

export interface MetaTemplateFormInput {
  body: string
  bodyExamples: string
  headerType: MetaHeaderType
  headerText: string
  headerExample: string
  footer: string
  buttons: MetaTemplateFormButton[]
}

type MetaComponent = Record<string, unknown>

function values(value: string): string[] {
  return value.split(/[\n,;]/).map(item => item.trim()).filter(Boolean)
}

function highestVariable(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g), match => Number(match[1])))
}

function requireExamples(text: string, supplied: string, label: string): string[] {
  const required = highestVariable(text)
  const examples = values(supplied)
  if (required > 0 && examples.length !== required) {
    throw new Error(`${label} usa ${required} variável(is). Informe ${required} exemplo(s).`)
  }
  return examples
}

export function formToMetaTemplateComponents(input: MetaTemplateFormInput): MetaComponent[] {
  const body = input.body.trim()
  if (!body) throw new Error('Escreva o corpo da mensagem.')

  const bodyExamples = requireExamples(body, input.bodyExamples, 'O corpo')
  const components: MetaComponent[] = []

  if (input.headerType === 'text') {
    const text = input.headerText.trim()
    if (!text) throw new Error('Escreva o texto do cabeçalho.')
    const examples = requireExamples(text, input.headerExample, 'O cabeçalho')
    components.push({ type: 'HEADER', format: 'TEXT', text, ...(examples.length ? { example: { header_text: examples } } : {}) })
  } else if (input.headerType !== 'none') {
    const handle = input.headerExample.trim()
    if (!handle) throw new Error('Informe o identificador de mídia de exemplo do cabeçalho.')
    components.push({ type: 'HEADER', format: input.headerType.toUpperCase(), example: { header_handle: [handle] } })
  }

  components.push({ type: 'BODY', text: body, ...(bodyExamples.length ? { example: { body_text: [bodyExamples] } } : {}) })

  const footer = input.footer.trim()
  if (footer) components.push({ type: 'FOOTER', text: footer })

  if (input.buttons.length) {
    const buttons = input.buttons.map((button) => {
      const text = button.text.trim()
      if (!text) throw new Error('Todo botão precisa de texto.')
      if (button.type === 'QUICK_REPLY') return { type: button.type, text }
      const value = button.value.trim()
      if (!value) throw new Error(button.type === 'URL' ? 'Informe a URL do botão.' : 'Informe o telefone do botão.')
      return button.type === 'URL' ? { type: button.type, text, url: value } : { type: button.type, text, phone_number: value }
    })
    components.push({ type: 'BUTTONS', buttons })
  }

  return components
}
