import 'server-only'
import { stackServerApp } from '@/stack'
import { db } from '@/lib/db'
import { companies, companyMembers } from '@/lib/db/schema'
import { eq, sql, and, isNull } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { verifyAgentSessionCookie } from '@/lib/agent-session'
import { resolveCompanyRole, roleSatisfies, type CompanyRole } from '@/lib/company-role'
import { canAcceptMemberInvite, normalizeMemberEmail } from '@/lib/member-invite-policy'

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

const ADMIN_EMAILS_DEFAULT = ['dr.trafego@gmail.com', 'amandafelixgolden@gmail.com', 'agente.ia@casaldotrafego.com']

export function checkIsAdmin(email: string | null | undefined): boolean {
  if (!email) return false
  const envAdmins = process.env.ADMIN_EMAILS
    ? process.env.ADMIN_EMAILS.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : []
  const allAdmins = Array.from(new Set([...ADMIN_EMAILS_DEFAULT.map(e => e.toLowerCase()), ...envAdmins]))
  return allAdmins.includes(email.toLowerCase())
}

export async function getCurrentUser() {
  try {
    const cookieStore = await cookies()
    const agentSession = cookieStore.get('agent_auth_session')?.value
    if (agentSession) {
      const verified = await verifyAgentSessionCookie(agentSession)
      if (verified) {
        return {
          id: verified.id,
          primaryEmail: verified.primaryEmail,
          displayName: verified.displayName,
          isAdmin: verified.isAdmin,
          primaryEmailVerified: true,
        }
      }
    }
  } catch {
    // cookie ausente/corrompido: segue para o Stack Auth
  }

  if (!stackServerApp) return null
  const user = await stackServerApp.getUser()
  if (!user) return null
  return { ...user, isAdmin: user.primaryEmailVerified && checkIsAdmin(user.primaryEmail) }
}

// Retorna a empresa a ser usada no contexto atual
// - Admin sem cookie → null (redirecionar para /empresas)
// - Admin com cookie admin_viewing → empresa do cookie
// - Client → empresa vinculada ao user, auto-cria se não existir
export async function getCurrentCompany() {
  const user = await getCurrentUser()
  if (!user) return null

  const isAdmin = user.isAdmin || (user.primaryEmailVerified && checkIsAdmin(user.primaryEmail))

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
    // prioriza a empresa central AutonomIA
    const [autonomiaCompany] = await db
      .select()
      .from(companies)
      .where(eq(companies.slug, 'autonomia'))
      .limit(1)

    if (autonomiaCompany) return autonomiaCompany

    // Busca a empresa vinculada ao próprio user ID
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

  const cookieStore = await cookies()

  // 1. Verificar convite de membro pendente por cookie (link clicado /invite/membro/[token])
  const pendingMemberInvite = cookieStore.get('pending_member_invite')?.value
  if (pendingMemberInvite) {
    const [membership] = await db
      .select()
      .from(companyMembers)
      .where(eq(companyMembers.inviteToken, pendingMemberInvite))

    if (membership && canAcceptMemberInvite(membership, user)) {
      const [accepted] = await db
        .update(companyMembers)
        .set({ stackAuthUserId: user.id, status: 'ativo', inviteToken: null, updatedAt: new Date() })
        .where(and(eq(companyMembers.id, membership.id), eq(companyMembers.inviteToken, pendingMemberInvite), eq(companyMembers.status, 'pending'), isNull(companyMembers.stackAuthUserId)))
        .returning()
      // The DB token is consumed above. This resolver also runs in Server
      // Components, where cookie writes are forbidden; the stale cookie
      // therefore expires naturally and cannot authorize another acceptance.

      const [memberCompany] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, membership.companyId))
      if (accepted && memberCompany) return memberCompany
    }
  }

  // 2. Verificar se já é membro ativo em companyMembers (por stackAuthUserId)
  const [activeMembership] = await db
    .select()
    .from(companyMembers)
    .where(and(eq(companyMembers.stackAuthUserId, user.id), eq(companyMembers.status, 'ativo')))

  if (activeMembership) {
    const [memberCompany] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, activeMembership.companyId))
    if (memberCompany) return memberCompany
  }

  // 3. Reconhecer pelo e-mail: se o e-mail do usuário foi cadastrado como membro em Configurações > Equipe
  if (user.primaryEmail && user.primaryEmailVerified) {
    const cleanUserEmail = user.primaryEmail.toLowerCase().trim()
    const [pendingByEmail] = await db
      .select()
      .from(companyMembers)
      .where(and(sql`lower(trim(${companyMembers.email})) = ${cleanUserEmail}`, eq(companyMembers.status, 'pending'), isNull(companyMembers.stackAuthUserId)))

    if (pendingByEmail && canAcceptMemberInvite(pendingByEmail, user)) {
      const [accepted] = await db
          .update(companyMembers)
          .set({ stackAuthUserId: user.id, status: 'ativo', inviteToken: null, updatedAt: new Date() })
          .where(and(eq(companyMembers.id, pendingByEmail.id), eq(companyMembers.inviteToken, pendingByEmail.inviteToken!), eq(companyMembers.status, 'pending'), isNull(companyMembers.stackAuthUserId)))
          .returning()

      const [memberCompany] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, pendingByEmail.companyId))
      if (accepted && memberCompany) return memberCompany
    }
  }

  // 4. Se não for membro de nenhuma empresa em companyMembers, verifica se é proprietário
  const [ownCompany] = await db
    .select()
    .from(companies)
    .where(eq(companies.stackAuthUserId, user.id))

  if (ownCompany) return ownCompany

  // 5. Convite de empresa legado (pending_invite)
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

  // 6. Auto-criação no primeiro login se não for membro nem proprietário de nenhuma empresa
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
  const user = await getCurrentUser()
  if (!user) throw new AuthError('Não autenticado')
  if (!user.isAdmin && !(user.primaryEmailVerified && checkIsAdmin(user.primaryEmail))) throw new AuthError('Acesso negado')
  return user
}

// ─── Cargo dentro da empresa (SAC Lote 1, item 5.5) ─────────────────────────
// requireCompany() resolve QUAL empresa; requireCompanyRole() decide O QUE o
// usuário pode fazer nela. Convite/promoção/exclusão de membros e alteração de
// credenciais exigem 'admin'; atendimento exige só 'membro'.

export class ForbiddenError extends Error {
  readonly status = 403
  constructor(message = 'Acesso negado: requer administrador da empresa') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export function forbiddenResponse(message?: string) {
  return NextResponse.json({ error: message ?? 'Acesso negado: requer administrador da empresa' }, { status: 403 })
}

export async function getCompanyAccess() {
  const company = await requireCompany()
  const user = await getCurrentUser()
  if (!user) throw new AuthError('Não autenticado')

  const memberships = await db
    .select({
      id: companyMembers.id,
      companyId: companyMembers.companyId,
      stackAuthUserId: companyMembers.stackAuthUserId,
      email: companyMembers.email,
      role: companyMembers.role,
      status: companyMembers.status,
    })
    .from(companyMembers)
    .where(eq(companyMembers.companyId, company.id))

  const { role, memberId } = resolveCompanyRole({
    companyId: company.id,
    userId: user.id,
    email: user.primaryEmail,
    isPlatformAdmin: Boolean(user.isAdmin) || Boolean(user.primaryEmailVerified && checkIsAdmin(user.primaryEmail)),
    companyOwnerUserId: company.stackAuthUserId ?? null,
    memberships,
  })

  if (!role) throw new ForbiddenError('Seu vínculo com esta empresa não está ativo.')
  return { company, user, role, memberId }
}

export async function requireCompanyRole(minimum: CompanyRole) {
  const access = await getCompanyAccess()
  if (!roleSatisfies(access.role, minimum)) throw new ForbiddenError()
  return access
}

/** A stable, authenticated owner for SAC actions; never reads actor identity from JSON. */
export async function requireSacActor() {
  const access = await requireCompanyRole('membro')
  const { company, user } = access
  let memberId = access.memberId
  if (!memberId) {
    if (access.role !== 'admin' && access.role !== 'platform_admin') throw new ForbiddenError()
    // Platform administrators and the company owner may not have a team row.
    // This insert is authorized by the authenticated role above, never by body/email lookup.
    const email = normalizeMemberEmail(user.primaryEmail)
    if (!email) throw new ForbiddenError('A conta precisa de e-mail para assumir atendimento.')
    const [existing] = await db.select().from(companyMembers).where(and(eq(companyMembers.companyId, company.id), eq(companyMembers.stackAuthUserId, user.id), eq(companyMembers.status, 'ativo'))).limit(1)
    if (existing) memberId = existing.id
    else {
      const [created] = await db.insert(companyMembers).values({ companyId: company.id, stackAuthUserId: user.id, email, name: user.displayName || email, role: access.role === 'admin' ? 'admin' : 'membro', status: 'ativo', inviteToken: null }).onConflictDoNothing().returning()
      if (created) memberId = created.id
      else {
        const [linked] = await db.select().from(companyMembers).where(and(eq(companyMembers.companyId, company.id), eq(companyMembers.stackAuthUserId, user.id), eq(companyMembers.status, 'ativo'))).limit(1)
        if (!linked) throw new ForbiddenError('Não foi possível vincular esta conta à equipe.')
        memberId = linked.id
      }
    }
  }
  return { ...access, memberId, actorId: user.id, actorName: user.displayName || user.primaryEmail || 'Atendente' }
}

