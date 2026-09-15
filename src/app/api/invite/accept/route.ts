import { NextResponse } from 'next/server'
import { stackServerApp } from '@/stack'
import { db } from '@/lib/db'
import { companies } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { cookies } from 'next/headers'

// Chamado após login para vincular usuário à empresa via invite token
export async function POST() {
  const user = await stackServerApp?.getUser()
  if (!user) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })

  const cookieStore = await cookies()
  const token = cookieStore.get('pending_invite')?.value
  if (!token) return NextResponse.json({ ok: false, reason: 'no_token' })

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.inviteToken, token))

  if (!company) {
    cookieStore.delete('pending_invite')
    return NextResponse.json({ ok: false, reason: 'invalid_token' })
  }

  // Vincular apenas se a empresa não tem usuário ainda
  if (!company.stackAuthUserId) {
    await db
      .update(companies)
      .set({ stackAuthUserId: user.id })
      .where(eq(companies.id, company.id))
  }

  cookieStore.delete('pending_invite')
  return NextResponse.json({ ok: true, companyId: company.id })
}
