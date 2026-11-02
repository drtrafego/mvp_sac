import { createHmac } from 'node:crypto'

const GATEWAY_TIMEOUT_MS = 20_000

function gatewayConfig() {
  const url = process.env.CODEX_GATEWAY_URL?.trim()
  const secret = process.env.CODEX_GATEWAY_SHARED_SECRET?.trim()
  if (!url || !secret) throw new Error('Gateway Codex do servidor não está configurado.')
  return { url: url.replace(/\/$/, ''), secret }
}

function signedHeaders(body: string, secret: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return { 'Content-Type': 'application/json', 'X-SAC-Timestamp': timestamp, 'X-SAC-Signature': signature }
}

async function gatewayRequest(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = gatewayConfig()
  const body = JSON.stringify(payload)
  const response = await fetch(`${config.url}${path}`, {
    method: 'POST',
    headers: signedHeaders(body, config.secret),
    body,
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
  })
  const result = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `Gateway Codex respondeu HTTP ${response.status}.`)
  return result
}

export function submitToCodexGateway(payload: Record<string, unknown>) {
  return gatewayRequest('/v1/sac/jobs', payload)
}

export function confirmCodexGatewayJob(payload: Record<string, unknown>) {
  return gatewayRequest(`/v1/sac/jobs/${encodeURIComponent(String(payload.jobId))}/confirm`, payload)
}
