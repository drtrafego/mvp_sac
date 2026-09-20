import { NextRequest, NextResponse } from 'next/server'
import { stackMiddlewareApp } from '@/stack.middleware'
import { isIpAllowed, getClientIp } from '@/lib/ip-auth'
import { verifyAgentSessionCookie } from '@/lib/agent-session'

const PUBLIC_PATHS = [
  '/handler',
  '/invite',
  '/api/webhooks',
  '/api/v1',
  '/api/agent',
  '/api/auth',
  '/api/admin',
  '/api/cron',
  '/robots.txt',
  '/sitemap.xml',
  '/_next',
  '/favicon.ico',
  '/public',
  '/index.html',
]

// Garante que after_auth_return_to só aponte pra um caminho da mesma origem.
// Whitelist por resultado (resolve com new URL() e compara origin), em vez de
// blacklist de prefixo: fecha qualquer caractere especial que o parser de URL
// trate como divisor de authority (ex.: "//", "/\", ou um caractere de
// controle que some no parsing e vire um desses dois na prática), sem
// depender de listar prefixo por prefixo.
function sanitizeReturnPath(pathname: string, base: URL) {
  try {
    const resolved = new URL(pathname, base)
    return resolved.origin === base.origin ? pathname : '/'
  } catch {
    return '/'
  }
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Permitir arquivos estáticos (css, js, json, svg, png, etc.)
  if (/\.(css|js|json|svg|png|jpg|jpeg|ico|woff|woff2|ttf|eot)$/i.test(pathname)) {
    return NextResponse.next()
  }

  // Se a rota for da API de Agente (/api/agent/...) e ALLOWED_IPS estiver configurada, valida o IP do agente
  if (pathname.startsWith('/api/agent/')) {
    if (!isIpAllowed(request)) {
      const clientIp = getClientIp(request)
      return NextResponse.json(
        { error: 'Acesso negado: IP não autorizado para o agente', ip: clientIp },
        { status: 403 }
      )
    }
  }

  // Se a rota for pública ou estática, permite sem autenticação adicional
  if (PUBLIC_PATHS.some(path => pathname.startsWith(path)) || pathname === '/') {
    return NextResponse.next()
  }

  // Se o usuário possui cookie de sessão de agente válido (assinado e não expirado), permite acesso direto ao painel
  const agentSession = request.cookies.get('agent_auth_session')?.value
  if (agentSession && (await verifyAgentSessionCookie(agentSession))) {
    return NextResponse.next()
  }

  const stackProjectId = process.env.NEXT_PUBLIC_STACK_PROJECT_ID || process.env.STACK_PROJECT_ID

  // Se o Stack Auth estiver configurado, exige autenticação do operador/admin para acessar o painel
  if (stackProjectId) {
    const user = await stackMiddlewareApp.getUser()
    if (!user) {
      const url = new URL('/handler/sign-in', request.url)
      url.searchParams.set('after_auth_return_to', sanitizeReturnPath(pathname, url))
      return NextResponse.redirect(url)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
