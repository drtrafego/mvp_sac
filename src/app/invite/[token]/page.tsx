import { redirect } from 'next/navigation'
import { db } from '@/lib/db'
import { companies } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { stackServerApp } from '@/stack'
import { cookies } from 'next/headers'

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.inviteToken, token))

  if (!company) {
    return (
      <div className="min-h-screen bg-surface-base flex items-center justify-center p-4">
        <div className="text-center">
          <h1 className="text-h1 text-fg mb-2">Link inválido</h1>
          <p className="text-body text-fg-muted">Este link de convite não existe ou expirou.</p>
        </div>
      </div>
    )
  }

  // Se já está logado, vincular o user à empresa e redirecionar
  const user = await stackServerApp?.getUser()
  if (user) {
    // Vincular se a empresa ainda não tem usuário
    if (!company.stackAuthUserId) {
      await db
        .update(companies)
        .set({ stackAuthUserId: user.id })
        .where(eq(companies.id, company.id))
    }
    redirect('/')
  }

  // Salvar o token em cookie para vincular após o signup
  const cookieStore = await cookies()
  cookieStore.set('pending_invite', token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60, // 1 hora
  })

  redirect('/handler/sign-up')
}
