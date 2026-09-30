import { db } from '@/lib/db'
import { settings, recoveryLeads } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import type { SidebarMenuConfig } from '@/components/layout/sidebar'

export interface ActiveConnectionsData {
  hotmart: boolean
  kiwify: boolean
  greenn: boolean
  zouti: boolean
  instagram: boolean
  mineracao: boolean
}

// Extraído de (dashboard)/layout.tsx (era função local `getCompanySidebarData`,
// duplicada implicitamente porque só a Sidebar a usava). A rota dedicada de
// Instagram e a navegação usam o mesmo activeConnections.instagram; assim a
// área não aparece nem abre para empresa sem Instagram configurado.
export async function getCompanySidebarData(companyId: number): Promise<{
  activeConnections: ActiveConnectionsData
  sidebarConfig: SidebarMenuConfig | null
}> {
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

    const hotmartEnabled = settingsRow?.hotmartEnabled !== false
    const hasHotmart = hotmartEnabled && !!(settingsRow?.hotmartWebhookToken || settingsRow?.hotmartClientId || platformSet.has('hotmart'))
    const hasKiwify = !!(settingsRow?.kiwifyWebhookToken || platformSet.has('kiwify'))
    const hasGreenn = !!(settingsRow?.greennWebhookToken || settingsRow?.greennApiKey || platformSet.has('greenn'))
    const hasZouti = !!(settingsRow?.zoutiWebhookToken || settingsRow?.zoutiApiKey || platformSet.has('zouti'))
    const hasInstagram = !!(settingsRow?.instagramAccountId || settingsRow?.instagramUsername || settingsRow?.instagramAccessToken || platformSet.has('instagram') || sourceSet.has('instagram') || sourceSet.has('instagram_direct'))
    const hasMineracao = !!(platformSet.has('mineracao') || sourceSet.has('mineracao') || sourceSet.has('prospeccao') || settingsRow?.brevoApiKey)

    // Se nenhuma plataforma estiver configurada ainda, mantém Hotmart/Geral como padrão
    const noneConfigured = !hasHotmart && !hasKiwify && !hasGreenn && !hasZouti && !hasInstagram && !hasMineracao

    const sidebarConfig = (settingsRow?.sidebarConfig as SidebarMenuConfig | undefined) || null
    const effectiveSidebarConfig =
      !hotmartEnabled && sidebarConfig
        ? { ...sidebarConfig, showHotmart: false }
        : sidebarConfig

    return {
      activeConnections: {
        hotmart: hotmartEnabled && (hasHotmart || noneConfigured),
        kiwify: hasKiwify,
        greenn: hasGreenn,
        zouti: hasZouti,
        instagram: hasInstagram,
        mineracao: hasMineracao,
      },
      sidebarConfig: effectiveSidebarConfig,
    }
  } catch {
    return {
      activeConnections: {
        hotmart: true,
        kiwify: false,
        greenn: false,
        zouti: false,
        instagram: false,
        mineracao: false,
      },
      sidebarConfig: null,
    }
  }
}
