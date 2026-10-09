export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { getCurrentCompany, getCurrentUser } from '@/lib/auth'
import { getCompanySidebarData } from '@/lib/company-sidebar'
import { Sidebar } from '@/components/layout/sidebar'
import { MobileTopbar } from '@/components/layout/mobile-topbar'
import { MobileTabBar } from '@/components/layout/mobile-tabbar'
import { AdminBanner } from '@/components/layout/admin-banner'
import { PageSurface } from '@/components/layout/page-surface'
import { Suspense } from 'react'

const MAIN_CLASS =
  'flex-1 min-h-0 overflow-y-auto flex flex-col bg-surface-base'

const SIDEBAR_FALLBACK = (
  <div className="hidden lg:block shrink-0 w-16 xl:w-[248px] 2xl:w-[272px] border-r border-line-subtle bg-surface-panel" />
)

// Sentinela real no DOM (não padding) que compensa a altura da bottom tab bar
// mobile (h-16 = 64px + borda + safe-area do notch + folga). Um padding-bottom
// no `main` não funciona aqui: com overflow-y-auto + flex-col e um filho flex
// (`min-h-0`) que estoura a altura do container, o Chromium não conta o
// padding de fechamento no scrollHeight e o final da página some atrás da nav
// mesmo assim. Elemento de verdade no fluxo resolve porque conta como
// conteúdo real, não como padding do container de scroll.
function BottomNavSpacer() {
  return (
    <div
      aria-hidden
      className="shrink-0 h-[calc(4rem+1px+env(safe-area-inset-bottom)+24px)] lg:hidden"
    />
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell flex flex-1 min-h-0 flex-col">
      <PageSurface>{children}</PageSurface>
      <BottomNavSpacer />
    </div>
  )
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/handler/sign-in')

  if (user.isAdmin) {
    const company = await getCurrentCompany()
    // Admin sem empresa selecionada → vai para painel admin
    if (!company) redirect('/empresas')

    const { activeConnections, sidebarConfig } = await getCompanySidebarData(company.id)

    return (
      <div className="flex flex-col h-dvh bg-surface-base">
        <AdminBanner companyName={company.name} companyId={company.id} />
        <div className="flex flex-1 overflow-hidden">
          <Suspense fallback={SIDEBAR_FALLBACK}>
            <Sidebar isAdmin activeConnections={activeConnections} sidebarConfig={sidebarConfig} />
          </Suspense>
          <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
            <MobileTopbar />
            <main className={MAIN_CLASS}>
              <Shell>{children}</Shell>
            </main>
          </div>
        </div>
        <MobileTabBar isAdmin activeConnections={activeConnections} />
      </div>
    )
  }

  // Cliente normal
  const company = await getCurrentCompany()
  if (!company) redirect('/handler/sign-in')

  const { activeConnections, sidebarConfig } = await getCompanySidebarData(company.id)

  return (
    <div className="flex h-dvh bg-surface-base">
      <Suspense fallback={SIDEBAR_FALLBACK}>
        <Sidebar activeConnections={activeConnections} sidebarConfig={sidebarConfig} />
      </Suspense>
      <div className="flex flex-1 min-w-0 flex-col overflow-hidden">
        <MobileTopbar />
        <main className={MAIN_CLASS}>
          <Shell>{children}</Shell>
        </main>
      </div>
      <MobileTabBar activeConnections={activeConnections} />
    </div>
  )
}
