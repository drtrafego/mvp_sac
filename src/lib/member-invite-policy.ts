import type { companyMembers } from '@/lib/db/schema'

export function normalizeMemberEmail(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

export function publicCompanyMember(member: typeof companyMembers.$inferSelect) {
  return { id: member.id, companyId: member.companyId, stackAuthUserId: member.stackAuthUserId,
    email: member.email, name: member.name, role: member.role, status: member.status,
    createdAt: member.createdAt, updatedAt: member.updatedAt }
}

/** A bearer invite never substitutes for the invited account's identity. */
export function canAcceptMemberInvite(
  invite: { email: string; status: string; inviteToken?: string | null; stackAuthUserId?: string | null },
  user: { id: string; primaryEmail?: string | null; primaryEmailVerified?: boolean },
): boolean {
  return invite.status === 'pending'
    && Boolean(invite.inviteToken)
    && !invite.stackAuthUserId
    && user.primaryEmailVerified === true
    && Boolean(normalizeMemberEmail(user.primaryEmail))
    && normalizeMemberEmail(invite.email) === normalizeMemberEmail(user.primaryEmail)
}
