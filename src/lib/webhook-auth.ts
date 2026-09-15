import { NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'

export type WebhookAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: string }

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// Autenticação própria de TODOS os webhooks: exige nosso token via querystring
// (?token=) ou header x-webhook-token, comparado com SAC_WEBHOOK_SECRET ou RECUPERAVENDAS_WEBHOOK_SECRET.
// Falha fechada: sem env definida -> 503; token ausente ou divergente -> 401.
export function checkWebhookToken(req: NextRequest): WebhookAuthResult {
  const secret =
    process.env.SAC_WEBHOOK_SECRET ||
    process.env.RECUPERAVENDAS_WEBHOOK_SECRET ||
    process.env.WEBHOOK_SECRET

  if (!secret) return { ok: false, status: 503, reason: 'webhook_secret_not_configured' }

  const incoming = req.nextUrl.searchParams.get('token') ?? req.headers.get('x-webhook-token')
  if (!incoming) return { ok: false, status: 401, reason: 'invalid_webhook_token' }

  // Saneamento defensivo para a Kiwify: ela pode concatenar a própria assinatura na
  // URL usando "?" em vez de "&" (".../rota?token=X?signature=Y"), e nesse caso o
  // searchParams devolve "X?signature=Y".
  const sanitized = incoming.split(/[?&]/)[0]
  if (!safeEqual(incoming, secret) && !safeEqual(sanitized, secret)) {
    return { ok: false, status: 401, reason: 'invalid_webhook_token' }
  }

  return { ok: true }
}
