// Resolução do cargo do usuário DENTRO da empresa ativa (SAC Lote 1, item 5.5).
//
// Escopo de empresa (requireCompany) e cargo são verificações distintas: antes
// desta função, qualquer pessoa com acesso à empresa conseguia convidar,
// promover, rebaixar e excluir membros, e alterar credenciais, porque as rotas
// só checavam requireCompany. Ocultar botão na interface não substitui a guarda
// no servidor.
//
// Função pura (sem 'server-only', sem banco) para poder ser testada direto.
// O wrapper que busca os dados fica em src/lib/auth.ts (getCompanyAccess).

export type CompanyRole = 'platform_admin' | 'admin' | 'membro'

export interface CompanyRoleMembership {
  id?: number
  companyId: number
  stackAuthUserId: string | null
  email: string
  role: string
}

export interface ResolveCompanyRoleInput {
  companyId: number
  userId: string
  email?: string | null
  isPlatformAdmin: boolean
  companyOwnerUserId?: string | null
  memberships: CompanyRoleMembership[]
}

export interface ResolvedCompanyRole {
  role: CompanyRole
  memberId: number | null
}

const RANK: Record<CompanyRole, number> = { membro: 1, admin: 2, platform_admin: 3 }

function normalizeEmail(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase()
}

/**
 * Ordem de decisão:
 * 1. Administrador da plataforma (lista de ADMIN_EMAILS) tem escopo próprio.
 * 2. Vínculo explícito em company_members DESTA empresa (por stackAuthUserId,
 *    depois por e-mail) usa o cargo gravado ('admin' | 'membro').
 * 3. Proprietário da empresa (companies.stack_auth_user_id) é admin.
 * 4. Qualquer outro caminho que chegou até a empresa vira 'membro': atende,
 *    mas não administra acessos nem credenciais.
 */
export function resolveCompanyRole(input: ResolveCompanyRoleInput): ResolvedCompanyRole {
  if (input.isPlatformAdmin) return { role: 'platform_admin', memberId: null }

  const sameCompany = input.memberships.filter((m) => m.companyId === input.companyId)
  const byId = sameCompany.find((m) => m.stackAuthUserId && m.stackAuthUserId === input.userId)
  const email = normalizeEmail(input.email)
  const byEmail = email ? sameCompany.find((m) => normalizeEmail(m.email) === email) : undefined
  const membership = byId ?? byEmail

  if (membership) {
    const role: CompanyRole = membership.role === 'admin' ? 'admin' : 'membro'
    return { role, memberId: membership.id ?? null }
  }

  if (input.companyOwnerUserId && input.companyOwnerUserId === input.userId) {
    return { role: 'admin', memberId: null }
  }

  return { role: 'membro', memberId: null }
}

export function roleSatisfies(role: CompanyRole, minimum: CompanyRole): boolean {
  return RANK[role] >= RANK[minimum]
}
