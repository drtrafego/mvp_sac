export const SUPPORTED_VARIABLES = [
  { token: '{nome}', label: 'Nome completo' },
  { token: '{primeiro_nome}', label: 'Primeiro nome' },
  { token: '{email}', label: 'E-mail' },
  { token: '{telefone}', label: 'Telefone' },
  { token: '{produto}', label: 'Produto / oferta' },
  { token: '{transacao}', label: 'Transação' },
  { token: '{cpf}', label: 'CPF/CNPJ' },
  { token: '{cidade}', label: 'Cidade' },
  { token: '{estado}', label: 'Estado' },
  { token: '{valor}', label: 'Valor' },
  { token: '{parcelas}', label: 'Parcelas' },
  { token: '{forma_pagamento}', label: 'Forma de pagamento' },
  { token: '{boleto_codigo}', label: 'Código do boleto' },
  { token: '{boleto_url}', label: 'Link do boleto' },
  { token: '{boleto_validade}', label: 'Validade do boleto' },
  { token: '{pix_codigo}', label: 'Código Pix' },
  { token: '{pix_validade}', label: 'Validade do Pix' },
  { token: '{link_checkout}', label: 'Link de checkout' },
  { token: '{afiliado}', label: 'Afiliado' },
] as const

export type VariableSource = { token: string; label: string } | { fixedValue: string }

export type TemplateLead = Record<string, string | null | undefined>

export function templateVariableMapKey(variable: string | number): string {
  const key = String(variable).trim()
  return key.replace(/^variavel_/, '')
}

export function templateVariableLabel(variable: string | number): string {
  const key = templateVariableMapKey(variable)
  return `Variável {{${key}}}`
}

export function isSupportedVariableSource(source: string): boolean {
  return SUPPORTED_VARIABLES.some(variable => variable.token === source)
}

/**
 * Retorna as variáveis na ordem que a Meta espera: posições numéricas 1..N,
 * seguidas das variáveis nomeadas na ordem em que aparecem no texto.
 */
export function extractTemplateVariableKeys(body: string): string[] {
  const numeric = new Set<number>()
  const named: string[] = []
  for (const match of body.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const raw = match[1].trim()
    if (!raw) continue
    if (/^\d+$/.test(raw)) numeric.add(Number(raw))
    else if (!named.includes(raw)) named.push(raw)
  }
  return [...numeric].sort((a, b) => a - b).map(index => `variavel_${index}`).concat(named)
}

function value(lead: TemplateLead, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = lead[key]
    if (candidate !== null && candidate !== undefined && String(candidate).trim()) return String(candidate)
  }
  return ''
}

function hasValue(lead: TemplateLead, ...keys: string[]): boolean {
  return Boolean(value(lead, ...keys))
}

function formatCurrency(valueInCents: string): string {
  const cents = Number(valueInCents)
  if (!Number.isFinite(cents)) return ''
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function formatDate(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR')
}

export function interpolateVariable(token: string, lead: TemplateLead): string {
  const normalizedToken = token.trim().toLowerCase()
  const name = value(lead, 'name', 'nome') || 'Cliente'

  switch (normalizedToken) {
    case '{nome}': return name
    case '{primeiro_nome}': return name.split(/\s+/)[0]
    case '{email}': return value(lead, 'email')
    case '{telefone}': return value(lead, 'phone', 'telefone')
    case '{produto}': return value(lead, 'productName', 'produto')
    case '{transacao}': return value(lead, 'transactionId', 'transacao')
    case '{cpf}': return value(lead, 'cpfCnpj', 'cpf')
    case '{cidade}': return value(lead, 'city', 'cidade')
    case '{estado}': return value(lead, 'state', 'estado')
    case '{valor}': return formatCurrency(value(lead, 'productValue', 'valor'))
    case '{parcelas}': return value(lead, 'installments', 'parcelas') || '1'
    case '{forma_pagamento}': return value(lead, 'paymentType', 'forma_pagamento')
    case '{boleto_codigo}': return value(lead, 'boletoCode', 'boleto_codigo')
    case '{boleto_url}': return value(lead, 'boletoUrl', 'boleto_url')
    case '{boleto_validade}': return formatDate(value(lead, 'boletoExpiry', 'boleto_validade'))
    case '{pix_codigo}': return value(lead, 'pixCode', 'pix_codigo')
    case '{pix_validade}': return formatDate(value(lead, 'pixExpiry', 'pix_validade'))
    case '{link_checkout}': return value(lead, 'checkoutUrl', 'link_checkout')
    case '{afiliado}': return value(lead, 'affiliateCode', 'afiliado')
    default: return ''
  }
}

export function resolveTemplateVariableSource(source: string | undefined, lead: TemplateLead): string {
  if (!source?.trim()) return ''
  return isSupportedVariableSource(source) ? interpolateVariable(source, lead) : source.trim()
}

export function renderTemplateVariableText(body: string, variables: Record<string, string>, lead: TemplateLead): string {
  return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim()
    return resolveTemplateVariableSource(variables[templateVariableMapKey(key)] ?? variables[key], lead) || `{{${key}}}`
  })
}

/**
 * Resolve a mapping without the display fallbacks used by the conversation
 * renderer. Dispatch previews must prove that every value exists on the
 * selected lead before a job is created.
 */
export function resolveTemplateVariableSourceStrict(source: string | undefined, lead: TemplateLead): string {
  const normalized = source?.trim() ?? ''
  if (!normalized) return ''
  if (!isSupportedVariableSource(normalized)) return normalized

  switch (normalized.toLowerCase()) {
    case '{nome}': return value(lead, 'name', 'nome')
    case '{primeiro_nome}': {
      const name = value(lead, 'name', 'nome')
      return name ? name.split(/\s+/)[0] : ''
    }
    case '{email}': return value(lead, 'email')
    case '{telefone}': return value(lead, 'phone', 'telefone')
    case '{produto}': return value(lead, 'productName', 'produto')
    case '{transacao}': return value(lead, 'transactionId', 'transacao')
    case '{cpf}': return value(lead, 'cpfCnpj', 'cpf')
    case '{cidade}': return value(lead, 'city', 'cidade')
    case '{estado}': return value(lead, 'state', 'estado')
    case '{valor}': return hasValue(lead, 'productValue', 'valor') ? formatCurrency(value(lead, 'productValue', 'valor')) : ''
    case '{parcelas}': return value(lead, 'installments', 'parcelas')
    case '{forma_pagamento}': return value(lead, 'paymentType', 'forma_pagamento')
    case '{boleto_codigo}': return value(lead, 'boletoCode', 'boleto_codigo')
    case '{boleto_url}': return value(lead, 'boletoUrl', 'boleto_url')
    case '{boleto_validade}': return formatDate(value(lead, 'boletoExpiry', 'boleto_validade'))
    case '{pix_codigo}': return value(lead, 'pixCode', 'pix_codigo')
    case '{pix_validade}': return formatDate(value(lead, 'pixExpiry', 'pix_validade'))
    case '{link_checkout}': return value(lead, 'checkoutUrl', 'link_checkout')
    case '{afiliado}': return value(lead, 'affiliateCode', 'afiliado')
    default: return ''
  }
}

export function renderTemplateVariableTextStrict(body: string, variables: Record<string, string>, lead: TemplateLead): string {
  return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim()
    return resolveTemplateVariableSourceStrict(variables[templateVariableMapKey(key)] ?? variables[key], lead) || `{{${key}}}`
  })
}

export function unresolvedTemplateVariableKeys(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map(match => match[1]))]
}

export function getAvailableVariableSources(leads: TemplateLead[]): Array<{ token: string; label: string }> {
  if (!leads.length) return [...SUPPORTED_VARIABLES]
  return SUPPORTED_VARIABLES.filter(source => leads.every(lead => Boolean(resolveTemplateVariableSourceStrict(source.token, lead))))
}
