/**
 * Valores de variável dos templates da Isabela (Kiwify). Isolado do
 * interpolate() genérico do cron de propósito: o cron é compartilhado por todas
 * as empresas, e estas regras valem só para os jobs de evento da Isabela.
 */

/** Primeiro nome do comprador; MAIÚSCULAS/minúsculas viram "Maria". Vazio vira "Cliente". */
export function isabelaFirstName(fullName: string | null | undefined): string {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? ''
  if (!first) return 'Cliente'
  if (first === first.toUpperCase() || first === first.toLowerCase()) {
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase()
  }
  return first
}

/**
 * Referência do pedido para o cliente: o order_ref curto da Kiwify quando o
 * payload tem, senão o transactionId (order_id, UUID de 36 caracteres, que só
 * serve de último recurso).
 */
export function isabelaOrderReference(lead: { rawPayload?: unknown; transactionId?: string | null }): string {
  const raw = lead.rawPayload
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const ref = (raw as Record<string, unknown>).order_ref
    if (typeof ref === 'string' && ref.trim()) return ref.trim()
  }
  return lead.transactionId ?? ''
}

/** dd/MM/yyyy no fuso de São Paulo (o vencimento é 23:59 BRT; em UTC viraria o dia seguinte). */
export function formatDateSaoPaulo(d: Date | null | undefined): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}
