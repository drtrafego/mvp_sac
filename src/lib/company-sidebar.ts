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
// duplicada implicitamente porque só a Sidebar a usava). O inbox/layout.tsx
// passa a chamar esta mesma função pra saber se a empresa tem Instagram
// configurado antes de mostrar o chip "Direct" no seletor de canal do Inbox:
// sem isso, o chip aparecia pra QUALQUER empresa, inclusive uma sem Instagram
// nenhum conectado, enquanto a seção "Instagram" do menu lateral (que usa o
// mesmo activeConnections.instagram) já ficava escondida nesse caso.
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
    const kiwifyEnabled = settingsRow?.kiwifyEnabled !== false
    const greennEnabled = settingsRow?.greennEnabled !== false
    const zoutiEnabled = settingsRow?.zoutiEnabled !== false
    const hasHotmart = hotmartEnabled && !!(settingsRow?.hotmartWebhookToken || settingsRow?.hotmartClientId || platformSet.has('hotmart'))
    const hasKiwify = kiwifyEnabled && !!(settingsRow?.kiwifyWebhookToken || platformSet.has('kiwify'))
    const hasGreenn = greennEnabled && !!(settingsRow?.greennWebhookToken || settingsRow?.greennApiKey || platformSet.has('greenn'))
    const hasZouti = zoutiEnabled && !!(settingsRow?.zoutiWebhookToken || settingsRow?.zoutiApiKey || platformSet.has('zouti'))
    const hasInstagram = !!(settingsRow?.instagramAccountId || settingsRow?.instagramUsername || settingsRow?.instagramAccessToken || platformSet.has('instagram') || sourceSet.has('instagram') || sourceSet.has('instagram_direct'))
    const hasMineracao = !!(platformSet.has('mineracao') || sourceSet.has('mineracao') || sourceSet.has('prospeccao') || settingsRow?.brevoApiKey)

    // Se nenhuma plataforma estiver configurada ainda, mantém Hotmart/Geral como padrão
    const noneConfigured = !hasHotmart && !hasKiwify && !hasGreenn && !hasZouti && !hasInstagram && !hasMineracao

    const sidebarConfig = (settingsRow?.sidebarConfig as SidebarMenuConfig | undefined) || null
    const effectiveSidebarConfig = sidebarConfig
      ? {
          ...sidebarConfig,
          ...(!hotmartEnabled ? { showHotmart: false } : {}),
          ...(!kiwifyEnabled ? { showKiwify: false } : {}),
          ...(!greennEnabled ? { showGreenn: false } : {}),
          ...(!zoutiEnabled ? { showZouti: false } : {}),
        }
      : null

    return {
      activeConnections: {
        hotmart: hotmartEnabled && (hasHotmart || noneConfigured),
        kiwify: kiwifyEnabled && hasKiwify,
        greenn: greennEnabled && hasGreenn,
        zouti: zoutiEnabled && hasZouti,
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
