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

type InstagramCredentialFields = Pick<
  typeof settings.$inferSelect,
  'instagramAccountId' | 'instagramPageId' | 'instagramAccessToken' | 'metaAccessToken'
>

/** Credenciais mínimas para receber/identificar a conta e enviar Direct. */
export function hasInstagramCredentials(row: InstagramCredentialFields | null | undefined): boolean {
  const accountId = row?.instagramAccountId?.trim() || row?.instagramPageId?.trim()
  const accessToken = row?.instagramAccessToken?.trim() || row?.metaAccessToken?.trim()
  return Boolean(accountId && accessToken)
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
    const kiwifyEnabled = settingsRow?.kiwifyEnabled !== false
    const greennEnabled = settingsRow?.greennEnabled !== false
    const zoutiEnabled = settingsRow?.zoutiEnabled !== false
    const hasHotmart = hotmartEnabled && !!(settingsRow?.hotmartWebhookToken || settingsRow?.hotmartClientId || platformSet.has('hotmart'))
    const hasKiwify = kiwifyEnabled && !!(settingsRow?.kiwifyWebhookToken || platformSet.has('kiwify'))
    const hasGreenn = greennEnabled && !!(settingsRow?.greennWebhookToken || settingsRow?.greennApiKey || platformSet.has('greenn'))
    const hasZouti = zoutiEnabled && !!(settingsRow?.zoutiWebhookToken || settingsRow?.zoutiApiKey || platformSet.has('zouti'))
    const hasInstagram = hasInstagramCredentials(settingsRow)
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
