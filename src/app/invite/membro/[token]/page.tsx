import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { companyMembers, companies } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { stackServerApp } from '@/stack'
import { cookies } from 'next/headers'

export default async function InviteMembroPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const [membership] = await db
    .select()
    .from(companyMembers)
    .where(eq(companyMembers.inviteToken, token))

  if (!membership) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center p-4">
        <div className="text-center">
          <h1 className="text-h1 text-fg mb-2">Link inválido</h1>
          <p className="text-body text-fg-muted">Este convite não existe ou expirou.</p>
        </div>
      </div>
    )
  }

  if (membership.status === 'ativo') {
    redirect('/')
  }

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, membership.companyId))

  // Se já está logado, vincular e redirecionar
  const user = await stackServerApp?.getUser()
  if (user) {
    await db
      .update(companyMembers)
      .set({ stackAuthUserId: user.id, status: 'ativo', updatedAt: new Date() })
      .where(eq(companyMembers.id, membership.id))
    redirect('/')
  }

  // Salvar token em cookie para vincular após signup/signin
  const cookieStore = await cookies()
  cookieStore.set('pending_member_invite', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24, // 24 horas
  })

  return (
    <div className="min-h-screen bg-surface-base flex items-center justify-center p-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="space-y-2">
          <div
            className="w-16 h-16 rounded-[var(--r-xl)] flex items-center justify-center mx-auto"
            style={{
              background: 'color-mix(in oklch, var(--brand-solid) 10%, transparent)',
              border: '1px solid color-mix(in oklch, var(--brand-solid) 22%, transparent)',
            }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-brand-ink">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <h1 className="text-h1 text-fg">Você foi convidado</h1>
          <p className="text-body text-fg-muted">
            Para administrar a empresa <span className="text-fg font-medium">{company?.name ?? 'SAC'}</span> como <span className="text-fg font-medium">{membership.role === 'admin' ? 'Administrador' : 'Membro'}</span>.
          </p>
        </div>
        <div className="space-y-3">
          <a
            href="/handler/sign-up"
            className="focus-ring block w-full rounded-[var(--r-md)] bg-brand-solid text-on-accent font-medium py-3 px-4 text-body transition-colors"
          >
            Criar minha conta
          </a>
          <a
            href="/handler/sign-in"
            className="focus-ring block w-full rounded-[var(--r-md)] bg-surface-inset border border-line-subtle text-fg font-medium py-3 px-4 text-body transition-colors hover:bg-surface-overlay"
          >
            Já tenho conta, entrar
          </a>
        </div>
        <p className="num text-micro text-fg-faint">
          Convidado para: {membership.email}
        </p>
      </div>
    </div>
  )
}
