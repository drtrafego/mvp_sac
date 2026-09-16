export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { getCurrentCompany, getCurrentUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { settings, recoveryLeads } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { Sidebar } from '@/components/layout/sidebar'
import { MobileTopbar } from '@/components/layout/mobile-topbar'
import { MobileTabBar } from '@/components/layout/mobile-tabbar'
import { AdminBanner } from '@/components/layout/admin-banner'
import { Suspense } from 'react'

const MAIN_CLASS =
  'flex-1 min-h-0 overflow-y-auto flex flex-col bg-surface-base'

const SIDEBAR_FALLBACK = (
  <div className="hidden lg:block shrink-0 w-16 xl:w-[248px] 2xl:w-[272px] border-r border-line-subtle bg-surface-panel" />
)

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="shell flex flex-1 min-h-0 flex-col">{children}</div>
}

async function getActiveConnections(companyId: number) {
  try {
    const [settingsRow] = await db
      .select()
      .from(settings)
      .where(eq(settings.companyId, companyId))

    // Checar se há leads de cada plataforma/origem
    const leadsPlatforms = await db
      .select({
        platform: recoveryLeads.platform,
        source: recoveryLeads.trackingSource,
      })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.companyId, companyId))
      .limit(200)

    const platformSet = new Set(leadsPlatforms.map(l => (l.platform || '').toLowerCase()))
    const sourceSet = new Set(leadsPlatforms.map(l => (l.source || '').toLowerCase()))

    const hasHotmart = !!(settingsRow?.hotmartWebhookToken || settingsRow?.hotmartClientId || platformSet.has('hotmart'))
    const hasKiwify = !!(settingsRow?.kiwifyWebhookToken || platformSet.has('kiwify'))
    const hasGreenn = !!(settingsRow?.greennWebhookToken || settingsRow?.greennApiKey || platformSet.has('greenn'))
    const hasZouti = !!(settingsRow?.zoutiWebhookToken || settingsRow?.zoutiApiKey || platformSet.has('zouti'))
    const hasInstagram = !!(settingsRow?.instagramAccountId || settingsRow?.instagramUsername || settingsRow?.instagramAccessToken || platformSet.has('instagram') || sourceSet.has('instagram') || sourceSet.has('instagram_direct'))
    const hasMineracao = !!(platformSet.has('mineracao') || sourceSet.has('mineracao') || sourceSet.has('prospeccao') || settingsRow?.brevoApiKey)

    // Se nenhuma plataforma estiver configurada ainda, mantém Hotmart/Geral como padrão
    const noneConfigured = !hasHotmart && !hasKiwify && !hasGreenn && !hasZouti && !hasInstagram && !hasMineracao

    return {
      hotmart: hasHotmart || noneConfigured,
      kiwify: hasKiwify,
      greenn: hasGreenn,
      zouti: hasZouti,
      instagram: hasInstagram,
      mineracao: hasMineracao,
    }
  } catch {
    return {
      hotmart: true,
      kiwify: false,
      greenn: false,
      zouti: false,
      instagram: false,
      mineracao: false,
    }
  }
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/handler/sign-in')

  if (user.isAdmin) {
    const company = await getCurrentCompany()
    // Admin sem empresa selecionada → vai para painel admin
    if (!company) redirect('/empresas')

    const activeConnections = await getActiveConnections(company.id)

    return (
      <div className="flex flex-col h-screen bg-surface-base">
        <AdminBanner companyName={company.name} companyId={company.id} />
        <div className="flex flex-1 overflow-hidden">
          <Suspense fallback={SIDEBAR_FALLBACK}>
            <Sidebar isAdmin activeConnections={activeConnections} />
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

  const activeConnections = await getActiveConnections(company.id)

  return (
    <div className="flex h-screen bg-surface-base">
      <Suspense fallback={SIDEBAR_FALLBACK}>
        <Sidebar activeConnections={activeConnections} />
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
