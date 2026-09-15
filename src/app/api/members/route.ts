import { NextResponse } from 'next/server'
import { requireCompany, getCurrentUser, unauthorizedResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { companyMembers, companies } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'crypto'

export async function GET() {
  try {
    const company = await requireCompany()
    const user = await getCurrentUser()

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

    return NextResponse.json({
      owner: {
        email: user?.primaryEmail ?? null,
        name: user?.displayName ?? null,
        stackAuthUserId: ownerCompany.stackAuthUserId,
      },
      members,
    })
  } catch {
    return unauthorizedResponse()
  }
}

export async function POST(req: Request) {
  try {
    const company = await requireCompany()
    const { email, role = 'admin' } = await req.json()

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email obrigatório' }, { status: 400 })
    }

    const validRoles = ['admin', 'membro']
    if (!validRoles.includes(role)) {
      return NextResponse.json({ error: 'Cargo inválido' }, { status: 400 })
    }

    // Verificar se já existe convite para este email nesta empresa
    const existing = await db
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.companyId, company.id))

    const alreadyExists = existing.find(m => m.email.toLowerCase() === email.toLowerCase())
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

    return NextResponse.json({ member, inviteUrl })
  } catch {
    return unauthorizedResponse()
  }
}
