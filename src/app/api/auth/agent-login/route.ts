import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { createAgentSessionCookie } from '@/lib/agent-session'

// Sem fallback hardcoded: a mesma chave hardcoded que existia aqui era a
// mesma string exposta em api/admin/audit-clients (removida dali por ser
// segredo previsível e versionado). Falha fechada se a env não existir.
const MASTER_AGENT_TOKEN = process.env.MASTER_AGENT_TOKEN?.trim()

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

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

  if (!MASTER_AGENT_TOKEN) {
    return NextResponse.json({ error: 'Login de agente desativado: MASTER_AGENT_TOKEN não configurado.' }, { status: 503 })
  }

  if (!token) {
    return NextResponse.json({ error: 'Token de acesso não fornecido.' }, { status: 400 })
  }

  const isValid = safeEqual(token, MASTER_AGENT_TOKEN)
  if (!isValid) {
    return NextResponse.json({ error: 'Token de acesso inválido ou expirado.' }, { status: 401 })
  }

  // Evita open redirect via "//evil.com" (começa com "/" mas é protocol-relative)
  const destination = redirectTo.startsWith('/') && !redirectTo.startsWith('//') ? redirectTo : '/'
  const response = NextResponse.redirect(new URL(destination, request.url))

  let sessionCookie: string
  try {
    sessionCookie = await createAgentSessionCookie(
      {
        id: 'agent-ia-casal-admin-id',
        primaryEmail: 'agente.ia@casaldotrafego.com',
        displayName: 'Agente IA (Admin)',
        isAdmin: true,
        companyId: DEFAULT_COMPANY_ID,
      },
      SESSION_TTL_MS
    )
  } catch {
    // getSecret() falha fechado quando AGENT_SESSION_SECRET/STACK_SECRET_SERVER_KEY
    // não estão configurados (ver src/lib/agent-session.ts). Sem isso, login de
    // agente fica desativado, nunca aceito com um segredo previsível.
    return NextResponse.json(
      { error: 'Login de agente desativado: AGENT_SESSION_SECRET (ou STACK_SECRET_SERVER_KEY) não configurado.' },
      { status: 503 }
    )
  }

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
