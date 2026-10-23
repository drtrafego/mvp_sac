export type MetaHeaderType = 'none' | 'text'
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

export function templateVariableNumbers(text: string): number[] {
  return [...new Set(Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g), match => Number(match[1])))].sort((a, b) => a - b)
}

function highestVariable(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g), match => Number(match[1])))
}

function requireSequentialVariables(text: string, label: string) {
  const variables = Array.from(text.matchAll(/\{\{\s*(\d+)\s*\}\}/g), match => Number(match[1]))
  const unique = [...new Set(variables)].sort((a, b) => a - b)
  if (unique.some((value, index) => value !== index + 1)) {
    throw new Error(`${label} precisa usar variáveis sequenciais, começando em {{1}}.`)
  }
}

function requireExamples(text: string, supplied: string, label: string): string[] {
  requireSequentialVariables(text, label)
  const required = highestVariable(text)
  const examples = values(supplied)
  if (required > 0 && examples.length !== required) {
    throw new Error(`${label} usa ${required} variável(is). Informe ${required} exemplo(s).`)
  }
  return examples
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
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
      if (button.type === 'URL') {
        if (!validUrl(value)) throw new Error('Informe uma URL HTTP(S) válida para o botão.')
        return { type: button.type, text, url: value }
      }
      if (!/^\+[1-9]\d{6,14}$/.test(value)) throw new Error('Informe um telefone no formato E.164, por exemplo +5511999999999.')
      return { type: button.type, text, phone_number: value }
    })
    components.push({ type: 'BUTTONS', buttons })
  }

  return components
}
