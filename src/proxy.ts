import { NextRequest, NextResponse } from 'next/server'
import { stackMiddlewareApp } from '@/stack.middleware'
import { isIpAllowed, getClientIp } from '@/lib/ip-auth'

const PUBLIC_PATHS = [
  '/handler',
  '/api/webhooks',
  '/_next',
  '/favicon.ico',
  '/public',
  '/index.html',
]

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

  const stackProjectId = process.env.NEXT_PUBLIC_STACK_PROJECT_ID || process.env.STACK_PROJECT_ID

  // Se o Stack Auth estiver configurado, exige autenticação do operador/admin para acessar o painel
  if (stackProjectId) {
    const user = await stackMiddlewareApp.getUser()
    if (!user) {
      const url = new URL('/handler/sign-in', request.url)
      url.searchParams.set('after_sign_in', pathname)
      return NextResponse.redirect(url)
    }
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
