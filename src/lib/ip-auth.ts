import { NextRequest, NextResponse } from 'next/server'

/**
 * Obtém o IP do cliente considerando os cabeçalhos de proxy (Vercel, Cloudflare, Nginx)
 */
export function getClientIp(req: NextRequest): string {
  const forwardedFor = req.headers.get('x-forwarded-for')
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim()
  }
  const realIp = req.headers.get('x-real-ip')
  if (realIp) {
    return realIp.trim()
  }
  const fallbackIp = (req as unknown as { ip?: string }).ip
  return fallbackIp || '127.0.0.1'
}

/**
 * Verifica se o IP do cliente está na lista de permissões (ALLOWED_IPS).
 * Se a variável ALLOWED_IPS não estiver definida, permite todas as conexões por padrão.
 */
export function isIpAllowed(req: NextRequest): boolean {
  const allowedIpsEnv = process.env.ALLOWED_IPS
  if (!allowedIpsEnv || allowedIpsEnv.trim() === '') {
    return true
  }

  const allowedIps = allowedIpsEnv
    .split(',')
    .map(ip => ip.trim())
    .filter(Boolean)

  if (allowedIps.includes('*')) {
    return true
  }

  const clientIp = getClientIp(req)
  return allowedIps.includes(clientIp)
}

export function ipDeniedResponse(clientIp: string) {
  return NextResponse.json(
    { error: 'Acesso negado: IP não autorizado', ip: clientIp },
    { status: 403 }
  )
}
