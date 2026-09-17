import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companyMembers, companies } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { createAgentSessionCookie } from '@/lib/agent-session'

// Token mestre só existe via variável de ambiente. Sem ela configurada, a
// comparação abaixo nunca bate e este caminho de login fica desabilitado
// (falha fechada), em vez de usar um valor fixo no código-fonte.
const MASTER_AGENT_TOKEN = process.env.MASTER_AGENT_TOKEN

const SESSION_TTL_MS = 12 * 60 * 60 * 1000 // 12h

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const token = searchParams.get('token')
  const redirectTo = searchParams.get('redirect') || searchParams.get('next') || '/'

  if (!token) {
    return NextResponse.json({ error: 'Token de acesso não fornecido.' }, { status: 400 })
  }

  const isMasterToken = Boolean(MASTER_AGENT_TOKEN) && token === MASTER_AGENT_TOKEN

  let isValid = isMasterToken
  let userEmail = 'agente.ia@casaldotrafego.com'
  let targetCompanyId = 14 // AutonomIA
  // Só o token mestre concede admin do sistema inteiro. Convite de empresa
  // ou de membro autentica apenas naquela empresa (nunca isAdmin global).
  const grantAdmin = isMasterToken

  if (!isValid) {
    try {
      const [member] = await db
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.inviteToken, token))
        .limit(1)

      if (member) {
        isValid = true
        userEmail = member.email
        targetCompanyId = member.companyId
      } else {
        const [comp] = await db
          .select()
          .from(companies)
          .where(eq(companies.inviteToken, token))
          .limit(1)

        if (comp) {
          isValid = true
          targetCompanyId = comp.id
        }
      }
    } catch (err) {
      console.error('Erro ao validar token de login:', err)
    }
  }

  if (!isValid) {
    return NextResponse.json({ error: 'Token de acesso inválido ou expirado.' }, { status: 401 })
  }

  const destination = redirectTo.startsWith('/') ? redirectTo : '/'
  const response = NextResponse.redirect(new URL(destination, request.url))

  const sessionCookie = await createAgentSessionCookie(
    {
      id: 'agent-ia-casal-admin-id',
      primaryEmail: userEmail,
      displayName: 'Agente IA (Admin)',
      isAdmin: grantAdmin,
      companyId: targetCompanyId,
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

  response.cookies.set('admin_viewing', String(targetCompanyId), {
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
