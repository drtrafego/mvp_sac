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

// Autenticação do webhook de conversão do Hermes (reserva/agendamento
// confirmado por bot no WhatsApp): token PRÓPRIO e SEPARADO do dos 4
// webhooks de checkout, achado ALTO do QA (22/09/2026). Este endpoint recebe
// chamadas de um script Python rodando num servidor Hetzner externo (bot do
// cliente), superfície de exposição maior que o checkout (que só recebe de
// Hotmart/Greenn/Zouti/Kiwify) — um vazamento aqui não deve comprometer o
// secret dos webhooks de venda. `HERMES_WEBHOOK_SECRET || SAC_WEBHOOK_SECRET`
// é fallback INTENCIONAL e temporário: só até a env var nova ser configurada
// na Vercel (não criada por esta tarefa, é passo de deploy). Assim que
// HERMES_WEBHOOK_SECRET existir, o Hermes já para de compartilhar segredo com
// o checkout sem precisar de outra alteração de código.
export function checkHermesWebhookToken(req: NextRequest): WebhookAuthResult {
  const secret = process.env.HERMES_WEBHOOK_SECRET || process.env.SAC_WEBHOOK_SECRET

  if (!secret) return { ok: false, status: 503, reason: 'webhook_secret_not_configured' }

  const incoming = req.nextUrl.searchParams.get('token') ?? req.headers.get('x-webhook-token')
  if (!incoming) return { ok: false, status: 401, reason: 'invalid_webhook_token' }

  const sanitized = incoming.split(/[?&]/)[0]
  if (!safeEqual(incoming, secret) && !safeEqual(sanitized, secret)) {
    return { ok: false, status: 401, reason: 'invalid_webhook_token' }
  }

  return { ok: true }
}
