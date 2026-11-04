import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin, unauthorizedResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { companies } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { cookies } from 'next/headers'
import { createTenantSelectionCookie } from '@/lib/agent-session'

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let admin
  try {
    admin = await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const { id } = await params
  const companyId = parseInt(id)
  if (Number.isNaN(companyId)) {
    return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
  }

  const [company] = await db.select().from(companies).where(eq(companies.id, companyId))
  if (!company) {
    return NextResponse.json({ error: 'Empresa não encontrada' }, { status: 404 })
  }

  const cookieStore = await cookies()
  const tenantCookie = await createTenantSelectionCookie(admin.id, company.id)
  cookieStore.set('tenant_viewing', tenantCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  })
  cookieStore.set('admin_viewing', id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 dias
  })
  if (company.slug) {
    cookieStore.set('admin_viewing_slug', company.slug.toLowerCase().trim(), {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
    })
  }

  return NextResponse.json({ ok: true })
}
