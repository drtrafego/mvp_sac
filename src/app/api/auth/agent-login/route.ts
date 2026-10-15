import { NextRequest, NextResponse } from 'next/server'
import { createAgentSessionCookie } from '@/lib/agent-session'
import {
  AGENT_SESSION_TTL_MS,
  configuredMasterAgentToken,
  isValidMasterAgentToken,
  parseAgentLoginOptions,
} from '@/lib/agent-login'

function loginOptionsFromUnknown(value: unknown) {
  if (value instanceof URLSearchParams) return parseAgentLoginOptions(value)

  const params = new URLSearchParams()
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const body = value as Record<string, unknown>
    if (typeof body.company_id === 'string') params.set('company_id', body.company_id)
    if (typeof body.name === 'string') params.set('name', body.name)
  }
  return parseAgentLoginOptions(params)
}

async function loginWithToken(request: NextRequest, token: string | null, redirectValue: unknown, optionsValue: unknown) {
  if (typeof redirectValue !== 'string') {
    return NextResponse.json({ error: 'Destino de redirecionamento inválido.' }, { status: 400 })
  }

  if (!configuredMasterAgentToken()) {
    return NextResponse.json({ error: 'Login de agente desativado: MASTER_AGENT_TOKEN não configurado.' }, { status: 503 })
  }

  if (!token) {
    return NextResponse.json({ error: 'Token de acesso não fornecido.' }, { status: 400 })
  }

  if (!(await isValidMasterAgentToken(token))) {
    return NextResponse.json({ error: 'Token de acesso inválido ou expirado.' }, { status: 401 })
  }

  const applicationOrigin = request.nextUrl.origin
  let destination: URL
  try {
    destination = new URL(redirectValue, applicationOrigin)
  } catch {
    return NextResponse.json({ error: 'Destino de redirecionamento inválido.' }, { status: 400 })
  }

  if (destination.origin !== applicationOrigin) {
    return NextResponse.json({ error: 'Destino de redirecionamento externo não permitido.' }, { status: 400 })
  }

  const response = NextResponse.redirect(destination)
  const { companyId, displayName } = loginOptionsFromUnknown(optionsValue)

  let sessionCookie: string
  try {
    sessionCookie = await createAgentSessionCookie(
      {
        id: 'agent-ia-casal-admin-id',
        primaryEmail: 'agente.ia@casaldotrafego.com',
        displayName,
        isAdmin: true,
        companyId,
      },
      AGENT_SESSION_TTL_MS
    )
  } catch {
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
    maxAge: AGENT_SESSION_TTL_MS / 1000,
  })
  response.cookies.set('admin_viewing', String(companyId), {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: AGENT_SESSION_TTL_MS / 1000,
  })

  return response
}

export async function POST(request: NextRequest) {
  const parsedBody: unknown = await request.json().catch(() => null)
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: 'O corpo da requisição deve ser um objeto JSON.' }, { status: 400 })
  }

  const body = parsedBody as Record<string, unknown>
  return loginWithToken(
    request,
    typeof body.token === 'string' ? body.token : null,
    body.redirect ?? body.next ?? '/',
    body,
  )
}
