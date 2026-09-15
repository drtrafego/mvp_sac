import 'server-only'
import { stackServerApp } from '@/stack'
import { db } from '@/lib/db'
import { companies, companyMembers } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

export class AuthError extends Error {
  readonly status = 401
  constructor(message: string) {
    super(message)
    this.name = 'AuthError'
  }
}

export function unauthorizedResponse() {
  return NextResponse.json({ error: 'Não autenticado' }, { status: 401 })
}

const ADMIN_EMAILS_DEFAULT = ['dr.trafego@gmail.com', 'amandafelixgolden@gmail.com']

export function checkIsAdmin(email: string | null | undefined): boolean {
  if (!email) return false
  const envAdmins = process.env.ADMIN_EMAILS
    ? process.env.ADMIN_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : []
  const allAdmins = Array.from(new Set([...ADMIN_EMAILS_DEFAULT.map(e => e.toLowerCase()), ...envAdmins]))
  return allAdmins.includes(email.toLowerCase())
}

export async function getCurrentUser() {
  if (!stackServerApp) return null
  const user = await stackServerApp.getUser()
  if (!user) return null
  return { ...user, isAdmin: checkIsAdmin(user.primaryEmail) }
}

// Retorna a empresa a ser usada no contexto atual
// - Admin sem cookie → null (redirecionar para /empresas)
// - Admin com cookie admin_viewing → empresa do cookie
// - Client → empresa vinculada ao user, auto-cria se não existir
export async function getCurrentCompany() {
  if (!stackServerApp) return null
  const user = await stackServerApp.getUser()
  if (!user) return null

  const isAdmin = checkIsAdmin(user.primaryEmail)

  if (isAdmin) {
    const cookieStore = await cookies()
    const viewingId = cookieStore.get('admin_viewing')?.value
    if (viewingId) {
      const [company] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, parseInt(viewingId)))
      if (company) return company
    }

    // Se o admin não selecionou uma empresa específica via admin_viewing cookie,
    // busca a empresa vinculada ao próprio user ID
    const [ownCompany] = await db
      .select()
      .from(companies)
      .where(eq(companies.stackAuthUserId, user.id))

    if (ownCompany) return ownCompany

    // Se não tiver empresa vinculada ao ID, busca por email de membro
    if (user.primaryEmail) {
      const [pendingByEmail] = await db
        .select()
        .from(companyMembers)
        .where(eq(companyMembers.email, user.primaryEmail.toLowerCase()))

      if (pendingByEmail) {
        const [memberCompany] = await db
          .select()
          .from(companies)
          .where(eq(companies.id, pendingByEmail.companyId))
        if (memberCompany) return memberCompany
      }
    }

    // Fallback: primeira empresa cadastrada no sistema
    const [firstCompany] = await db
      .select()
      .from(companies)
      .limit(1)

    if (firstCompany) return firstCompany

    // Auto-cria a empresa se nenhuma existir
    const baseName = user.displayName || user.primaryEmail?.split('@')[0] || 'admin'
    const baseSlug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`

    const [created] = await db
      .insert(companies)
      .values({ stackAuthUserId: user.id, name: baseName, slug })
      .onConflictDoNothing({ target: companies.stackAuthUserId })
      .returning()

    return created ?? null
  }

  // Fluxo normal: empresa vinculada ao user (proprietário)
  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.stackAuthUserId, user.id))

  if (company) return company

  const cookieStore = await cookies()

  // Verificar convite de membro pendente
  const pendingMemberInvite = cookieStore.get('pending_member_invite')?.value
  if (pendingMemberInvite) {
    const [membership] = await db
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.inviteToken, pendingMemberInvite))

    if (membership && membership.status === 'pending') {
      await db
        .update(companyMembers)
        .set({ stackAuthUserId: user.id, status: 'ativo', updatedAt: new Date() })
        .where(eq(companyMembers.id, membership.id))
      cookieStore.delete('pending_member_invite')

      const [memberCompany] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, membership.companyId))
      if (memberCompany) return memberCompany
    }
  }

  // Verificar se já é membro ativo de alguma empresa (por ID)
  const [activeMembership] = await db
    .select()
    .from(companyMembers)
    .where(eq(companyMembers.stackAuthUserId, user.id))

  if (activeMembership) {
    const [memberCompany] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, activeMembership.companyId))
    if (memberCompany) return memberCompany
  }

  // Reconhecer pelo email: se o email do usuário foi pré-cadastrado como membro,
  // vincula automaticamente sem precisar de link de convite
  if (user.primaryEmail) {
    const [pendingByEmail] = await db
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.email, user.primaryEmail.toLowerCase()))

    if (pendingByEmail) {
      await db
        .update(companyMembers)
        .set({ stackAuthUserId: user.id, status: 'ativo', updatedAt: new Date() })
        .where(eq(companyMembers.id, pendingByEmail.id))

      const [memberCompany] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, pendingByEmail.companyId))
      if (memberCompany) return memberCompany
    }
  }

  // Verificar invite pendente (convite de empresa legado)
  const pendingInvite = cookieStore.get('pending_invite')?.value
  if (pendingInvite) {
    const [inviteCompany] = await db
      .select()
      .from(companies)
      .where(eq(companies.inviteToken, pendingInvite))

    if (inviteCompany && !inviteCompany.stackAuthUserId) {
      const [linked] = await db
        .update(companies)
        .set({ stackAuthUserId: user.id })
        .where(eq(companies.id, inviteCompany.id))
        .returning()
      cookieStore.delete('pending_invite')
      if (linked) return linked
    }
  }

  // Auto-cria a empresa no primeiro login (sem invite)
  const baseName = user.displayName || user.primaryEmail?.split('@')[0] || 'empresa'
  const baseSlug = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`

  const [created] = await db
    .insert(companies)
    .values({ stackAuthUserId: user.id, name: baseName, slug })
    .onConflictDoNothing({ target: companies.stackAuthUserId })
    .returning()

  if (created) return created

  const [existing] = await db
    .select()
    .from(companies)
    .where(eq(companies.stackAuthUserId, user.id))

  return existing ?? null
}

import { redirect } from 'next/navigation'

export async function requireCompany() {
  const company = await getCurrentCompany()
  if (!company) {
    redirect('/handler/sign-in')
  }
  return company
}

// Verifica se o usuário atual é admin — para proteger rotas admin
export async function requireAdmin() {
  if (!stackServerApp) throw new AuthError('Não autenticado')
  const user = await stackServerApp.getUser()
  if (!user) throw new AuthError('Não autenticado')
  if (!checkIsAdmin(user.primaryEmail)) throw new AuthError('Acesso negado')
  return user
}
