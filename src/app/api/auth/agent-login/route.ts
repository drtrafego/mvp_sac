import { NextRequest, NextResponse } from 'next/server'
import { createAgentSessionCookie } from '@/lib/agent-session'

const MASTER_AGENT_TOKEN = process.env.MASTER_AGENT_TOKEN || 'adm_agent_56027377818c36cb6c192cb5dc7fba0622d8'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12h
const DEFAULT_COMPANY_ID = 14 // AutonomIA

// Login só pelo token mestre de agente. O fallback que também aceitava
// invite_token de empresa/membro foi removido: não é usado em nenhum lugar
// do app (convite real passa por /invite/[token] e /invite/membro/[token],
// com Stack Auth de verdade) e permitia que um invite token comum, feito
// pra convidar UM cliente, virasse admin do sistema inteiro.
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const token = searchParams.get('token')
  const redirectTo = searchParams.get('redirect') || searchParams.get('next') || '/'

  if (!token) {
    return NextResponse.json({ error: 'Token de acesso não fornecido.' }, { status: 400 })
  }

  const isValid = Boolean(MASTER_AGENT_TOKEN) && token === MASTER_AGENT_TOKEN
  if (!isValid) {
    return NextResponse.json({ error: 'Token de acesso inválido ou expirado.' }, { status: 401 })
  }

  // Evita open redirect via "//evil.com" (começa com "/" mas é protocol-relative)
  const destination = redirectTo.startsWith('/') && !redirectTo.startsWith('//') ? redirectTo : '/'
  const response = NextResponse.redirect(new URL(destination, request.url))

  const sessionCookie = await createAgentSessionCookie(
    {
      id: 'agent-ia-casal-admin-id',
      primaryEmail: 'agente.ia@casaldotrafego.com',
      displayName: 'Agente IA (Admin)',
      isAdmin: true,
      companyId: DEFAULT_COMPANY_ID,
    },
    SESSION_TTL_MS
  )

  response.cookies.set('agent_auth_session', sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })

  response.cookies.set('admin_viewing', String(DEFAULT_COMPANY_ID), {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })

  return response
}

export async function POST(request: NextRequest) {
  return GET(request)
}
