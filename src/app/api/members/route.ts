import { NextResponse } from 'next/server'
import { requireCompanyRole, getCurrentUser, unauthorizedResponse, forbiddenResponse, ForbiddenError } from '@/lib/auth'
import { db } from '@/lib/db'
import { companyMembers, companies } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'crypto'
import { publicCompanyMember } from '@/lib/member-invite-policy'

export async function GET() {
  try {
    const { company, user } = await requireCompanyRole('membro')

    const members = await db
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.companyId, company.id))
      .orderBy(companyMembers.createdAt)

    // Buscar info do proprietário na tabela companies
    const [ownerCompany] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, company.id))

    // Filtrar para não listar o próprio proprietário duas vezes se ele já estiver na lista de membros
    const filteredMembers = members.filter(
      m => !ownerCompany?.stackAuthUserId || m.stackAuthUserId !== ownerCompany.stackAuthUserId
    )

    return NextResponse.json({
      owner: {
        email: user.id === ownerCompany?.stackAuthUserId ? user.primaryEmail : members.find(m => m.stackAuthUserId === ownerCompany?.stackAuthUserId)?.email ?? null,
        name: user.id === ownerCompany?.stackAuthUserId ? user.displayName : members.find(m => m.stackAuthUserId === ownerCompany?.stackAuthUserId)?.name ?? null,
        stackAuthUserId: ownerCompany?.stackAuthUserId ?? null,
      },
      members: filteredMembers.map(publicCompanyMember),
    })
  } catch {
    return unauthorizedResponse()
  }
}

export async function POST(req: Request) {
  try {
    // Convidar membro é operação administrativa (SAC Lote 1, 5.5).
    const { company } = await requireCompanyRole('admin')
    const { email, role = 'admin' } = await req.json()

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return NextResponse.json({ error: 'Email obrigatório' }, { status: 400 })
    }

    const validRoles = ['admin', 'membro']
    if (!validRoles.includes(role)) {
      return NextResponse.json({ error: 'Cargo inválido' }, { status: 400 })
    }

    const user = await getCurrentUser()
    if (user?.primaryEmail && email.toLowerCase().trim() === user.primaryEmail.toLowerCase().trim()) {
      return NextResponse.json({ error: 'Você já é o proprietário desta empresa.' }, { status: 400 })
    }

    // Verificar se já existe convite para este email nesta empresa
    const existing = await db
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.companyId, company.id))

    const alreadyExists = existing.find(m => m.email.toLowerCase().trim() === email.toLowerCase().trim())
    if (alreadyExists) {
      return NextResponse.json({ error: 'Este email já foi convidado ou já é membro.' }, { status: 409 })
    }

    const inviteToken = randomBytes(32).toString('hex')

    const [member] = await db
      .insert(companyMembers)
      .values({
        companyId: company.id,
        email: email.toLowerCase().trim(),
        role,
        inviteToken,
        status: 'pending',
      })
      .returning()

    const origin = req.headers.get('origin') ?? ''
    const inviteUrl = `${origin}/invite/membro/${inviteToken}`

    return NextResponse.json({ member: publicCompanyMember(member), inviteUrl })
  } catch (err) {
    if (err instanceof ForbiddenError) return forbiddenResponse()
    return unauthorizedResponse()
  }
}
