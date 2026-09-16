import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, unauthorizedResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { companies, settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { randomBytes } from 'crypto'
function genToken() { return randomBytes(24).toString('hex') }

export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      slug: companies.slug,
      plan: companies.plan,
      stackAuthUserId: companies.stackAuthUserId,
      inviteToken: companies.inviteToken,
      createdAt: companies.createdAt,
      sidebarConfig: settings.sidebarConfig,
    })
    .from(companies)
    .leftJoin(settings, eq(companies.id, settings.companyId))
    .orderBy(companies.createdAt)

  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const { name, slug, plan } = await req.json()
  if (!name || !slug) return NextResponse.json({ error: 'name e slug obrigatórios' }, { status: 400 })

  const inviteToken = genToken()

  const [company] = await db
    .insert(companies)
    .values({ name, slug, plan: plan || 'free', inviteToken })
    .returning()

  // Cria settings vazio para a empresa
  await db.insert(settings).values({ companyId: company.id }).onConflictDoNothing()

  return NextResponse.json(company, { status: 201 })
}
