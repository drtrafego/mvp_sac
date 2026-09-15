export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { getCurrentCompany, getCurrentUser } from '@/lib/auth'
import { Sidebar } from '@/components/layout/sidebar'
import { MobileTopbar } from '@/components/layout/mobile-topbar'
import { MobileTabBar } from '@/components/layout/mobile-tabbar'
import { AdminBanner } from '@/components/layout/admin-banner'
import { Suspense } from 'react'

/*
  O padding acompanha a largura da tela em vez de ter dois degraus fixos, e o
  fundo continua sangrando de borda a borda. O teto de largura fica no wrapper
  interno, então em monitor grande sobra margem simétrica em vez de card esticado.
  O pb extra no celular reserva o espaço da tab bar inferior.
*/
const MAIN_CLASS =
  'scroll-thin flex-1 overflow-auto p-[var(--space-shell)] pb-[calc(var(--space-shell)+5rem)] lg:pb-[var(--space-shell)] bg-surface-base'

const SIDEBAR_FALLBACK = (
  <div className="hidden lg:block shrink-0 w-16 xl:w-[248px] 2xl:w-[272px] border-r border-line-subtle bg-surface-panel" />
)

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="shell flex min-h-full flex-col">{children}</div>
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/handler/sign-in')

  if (user.isAdmin) {
    const company = await getCurrentCompany()
    // Admin sem empresa selecionada → vai para painel admin
    if (!company) redirect('/empresas')

    return (
      <div className="flex flex-col h-screen bg-surface-base">
        <AdminBanner companyName={company.name} companyId={company.id} />
        <div className="flex flex-1 overflow-hidden">
          <Suspense fallback={SIDEBAR_FALLBACK}>
            <Sidebar isAdmin />
          </Suspense>
          <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
            <MobileTopbar />
            <main className={MAIN_CLASS}>
              <Shell>{children}</Shell>
            </main>
          </div>
        </div>
        <MobileTabBar isAdmin />
      </div>
    )
  }

  // Cliente normal
  const company = await getCurrentCompany()
  if (!company) redirect('/handler/sign-in')

  return (
    <div className="flex h-screen bg-surface-base">
      <Suspense fallback={SIDEBAR_FALLBACK}>
        <Sidebar />
      </Suspense>
      <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
        <MobileTopbar />
        <main className={MAIN_CLASS}>
          <Shell>{children}</Shell>
        </main>
      </div>
      <MobileTabBar />
    </div>
  )
}
