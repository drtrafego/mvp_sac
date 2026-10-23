export const SUPPORTED_VARIABLES = [
  { token: '{nome}', label: 'Nome completo' },
  { token: '{primeiro_nome}', label: 'Primeiro nome' },
  { token: '{email}', label: 'E-mail' },
  { token: '{telefone}', label: 'Telefone' },
  { token: '{produto}', label: 'Produto' },
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

function value(lead: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = lead[key]
    if (candidate) return candidate
  }
  return ''
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

export function interpolateVariable(token: string, lead: Record<string, string>): string {
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
