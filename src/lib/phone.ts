/**
 * Normalização única de telefones para todo o sistema (importação de planilhas,
 * webhooks, envios de WhatsApp, deduplicação e busca no Inbox).
 *
 * Garante que variações com ou sem DDI (55), com ou sem nono dígito (9),
 * e com ou sem zero de discagem (0xx) convirjam para o formato E.164 canônico.
 */
export function formatBrazilianPhone(raw: string | null | undefined): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  const isExplicitInternational = trimmed.startsWith('+') && !trimmed.startsWith('+55')
  let digits = trimmed.replace(/\D/g, '')
  if (!digits) return ''

  if (isExplicitInternational) {
    return digits
  }

  // Remove zero(s) de discagem à esquerda (ex: 011999999999 -> 11999999999)
  while (digits.startsWith('0')) {
    digits = digits.slice(1)
  }

  // Já tem DDI 55
  if (digits.startsWith('55')) {
    const local = digits.slice(2)
    // 55 + DDD (2) + 9 + 8 dígitos = 11 locais (13 no total) -> completo
    if (local.length === 11) return digits
    // 55 + DDD (2) + 8 dígitos = 10 locais -> insere o nono dígito (9) após o DDD
    if (local.length === 10) return '55' + local.slice(0, 2) + '9' + local.slice(2)
    return digits
  }

  // DDI de outro país (não começa com 55 e tem mais de 11 dígitos): preserva
  if (digits.length > 11) return digits

  // Número brasileiro local (DDD + 9 dígitos = 11)
  if (digits.length === 11) return '55' + digits

  // Número brasileiro local antigo sem o 9 (DDD + 8 dígitos = 10)
  if (digits.length === 10) return '55' + digits.slice(0, 2) + '9' + digits.slice(2)

  // Caso curto / fallback
  return digits.length >= 8 ? '55' + digits : digits
}

export const normalizePhone = formatBrazilianPhone
