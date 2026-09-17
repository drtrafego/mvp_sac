import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companyMembers, companies } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

const MASTER_AGENT_TOKEN = 'adm_agent_56027377818c36cb6c192cb5dc7fba0622d8'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const token = searchParams.get('token')
  const redirectTo = searchParams.get('redirect') || searchParams.get('next') || '/'

  if (!token) {
    return NextResponse.json({ error: 'Token de acesso não fornecido.' }, { status: 400 })
  }

  let isValid = token === MASTER_AGENT_TOKEN
  let userEmail = 'agente.ia@casaldotrafego.com'
  let targetCompanyId = 14 // AutonomIA

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

  const sessionData = {
    id: 'agent-ia-casal-admin-id',
    primaryEmail: userEmail,
    displayName: 'Agente IA (Admin)',
    isAdmin: true,
    companyId: targetCompanyId,
  }

  const destination = redirectTo.startsWith('/') ? redirectTo : '/'
  const response = NextResponse.redirect(new URL(destination, request.url))

  response.cookies.set('agent_auth_session', JSON.stringify(sessionData), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  })

  response.cookies.set('admin_viewing', String(targetCompanyId), {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
  })

  return response
}

export async function POST(request: NextRequest) {
  return GET(request)
}
