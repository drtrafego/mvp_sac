import 'server-only'

// Sessão de agente assinada (HMAC-SHA256 via Web Crypto, compatível com Edge Runtime
// do proxy e com o runtime Node das rotas). Substitui o cookie JSON solto que era
// aceito sem nenhuma verificação de assinatura ou expiração.

export interface AgentSessionPayload {
  id: string
  primaryEmail: string
  displayName: string
  companyId?: number
  isAdmin: boolean
  exp: number // epoch ms
}

function getSecret(): string {
  const secret = process.env.AGENT_SESSION_SECRET
  if (!secret) throw new Error('AGENT_SESSION_SECRET não configurado')
  return secret
}

function toBase64Url(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes)
  let str = ''
  for (let i = 0; i < arr.length; i++) str += String.fromCharCode(arr[i])
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(b64url: string): Uint8Array {
  const pad = (4 - (b64url.length % 4 || 4)) % 4
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const str = atob(b64)
  const arr = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i)
  return arr
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}

// TTL curto por padrão. A sessão de agente é um mecanismo de acesso privilegiado,
// não deve durar 30 dias como o cookie antigo.
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000 // 12h

export async function createAgentSessionCookie(
  data: Omit<AgentSessionPayload, 'exp'>,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<string> {
  const payload: AgentSessionPayload = { ...data, exp: Date.now() + ttlMs }
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)).buffer as ArrayBuffer)
  const key = await hmacKey()
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64))
  return `${payloadB64}.${toBase64Url(sigBuf)}`
}

export async function verifyAgentSessionCookie(
  cookieValue: string | undefined | null
): Promise<AgentSessionPayload | null> {
  if (!cookieValue) return null
  const parts = cookieValue.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, sig] = parts

  try {
    const key = await hmacKey()
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64Url(sig) as BufferSource,
      new TextEncoder().encode(payloadB64)
    )
    if (!valid) return null

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64))) as AgentSessionPayload
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
    if (typeof payload.isAdmin !== 'boolean') return null
    return payload
  } catch {
    return null
  }
}
