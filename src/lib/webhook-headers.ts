import { NextRequest } from 'next/server'

/**
 * Mascaramento de headers antes de gravar em webhook_received.
 *
 * Cada webhook mascarava a sua própria lista, e as listas estavam incompletas:
 * o hottok da Hotmart chega em "x-hotmart-hottok", não em
 * "x-hotmart-webhook-token", então nunca era mascarado. Pior, a Vercel injeta
 * "x-vercel-oidc-token" (JWT de credencial do projeto) e
 * "x-vercel-proxy-signature" em toda requisição, e os dois iam para o banco em
 * texto puro e apareciam na página de Webhooks Log.
 *
 * Lista única, comparada em minúsculas, mais um teste por padrão para pegar
 * variações futuras sem precisar editar isto de novo.
 */
const HEADERS_SENSIVEIS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-webhook-token',
  'x-hotmart-hottok',
  'x-hotmart-webhook-token',
  'x-zouti-token',
  'x-zouti-signature',
  'x-kiwify-signature',
  'x-greenn-token',
  'x-vercel-oidc-token',
  'x-vercel-proxy-signature',
  'x-vercel-sc-headers',
])

// Pega qualquer coisa que pareça credencial e não esteja na lista acima.
const PADRAO_SENSIVEL = /(token|secret|signature|password|api[-_]?key|authorization)/i

function mascarar(valor: string): string {
  if (!valor) return ''
  return valor.length <= 4 ? '***' : `***${valor.slice(-4)}`
}

/** Converte os headers da requisição em objeto, mascarando os sensíveis. */
export function maskedHeaders(req: NextRequest): Record<string, string> {
  const out: Record<string, string> = {}
  req.headers.forEach((valor, chave) => {
    const k = chave.toLowerCase()
    out[chave] = HEADERS_SENSIVEIS.has(k) || PADRAO_SENSIVEL.test(k) ? mascarar(valor) : valor
  })
  return out
}
