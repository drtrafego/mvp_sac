import { eq } from 'drizzle-orm'
import { recoveryLeads, settings } from '@/lib/db/schema'
import { extractLeadOrigins } from '@/lib/origins'
import type { db as productionDatabase } from '@/lib/db'

export type DashboardOriginKey =
  | 'mineracao'
  | 'anuncio'
  | 'instagram'
  | 'hotmart'
  | 'kiwify'
  | 'greenn'
  | 'zouti'

export type DashboardOriginPills = {
  categories: Set<DashboardOriginKey>
  anuncioSubcategories: Set<'meta_ads' | 'google_ads'>
}

type OriginLeadRow = {
  trackingSource: string | null
  platform: string | null
  utmMedium: string | null
  eventType: string | null
  channel: string | null
}

type OriginPillsDatabase = Pick<typeof productionDatabase, 'select' | 'selectDistinct'>

const CHECKOUT_KEYS = new Set<DashboardOriginKey>(['hotmart', 'kiwify', 'greenn', 'zouti'])

function checkoutKey(row: OriginLeadRow, subcategory: string | undefined): DashboardOriginKey | null {
  if (!subcategory || !CHECKOUT_KEYS.has(subcategory as DashboardOriginKey)) return null

  // Pill de checkout exige identificador canônico, não substring em texto
  // livre. Isso evita transformar, por exemplo, uma campanha chamada
  // "comparativo_kiwify" em venda real da Kiwify. Os webhooks oficiais
  // persistem platform com o nome exato do provedor.
  const exactSignals = [row.platform, row.trackingSource]
    .map(value => value?.trim().toLowerCase())
    .filter(Boolean)
  if (exactSignals.includes(subcategory)) {
    return subcategory as DashboardOriginKey
  }
  return null
}

/**
 * Monta somente as origens comprovadas pelos leads recebidos. A categoria de
 * primeiro nível de tráfego pago é sempre "Anúncio"; Meta/Google ficam na
 * segunda dimensão, igual ao Inbox e a normalizeOrigin().
 */
export function buildDashboardOriginPills(
  rows: OriginLeadRow[],
  options: { disabledCheckouts?: ReadonlySet<DashboardOriginKey> } = {},
): DashboardOriginPills {
  const categories = new Set<DashboardOriginKey>()
  const anuncioSubcategories = new Set<'meta_ads' | 'google_ads'>()
  const disabledCheckouts = options.disabledCheckouts ?? new Set<DashboardOriginKey>()

  for (const row of rows) {
    for (const origin of extractLeadOrigins(row)) {
      if (origin.category === 'mineracao' || origin.category === 'instagram') {
        categories.add(origin.category)
        continue
      }

      if (origin.category === 'anuncio') {
        categories.add('anuncio')
        if (origin.subcategory === 'meta_ads' || origin.subcategory === 'google_ads') {
          anuncioSubcategories.add(origin.subcategory)
        }
        continue
      }

      if (origin.category === 'checkout') {
        const key = checkoutKey(row, origin.subcategory)
        if (key && !disabledCheckouts.has(key)) categories.add(key)
      }
    }
  }

  return { categories, anuncioSubcategories }
}

/** Consulta deliberadamente tenant-bound: nenhum pill pode nascer de lead de outra empresa. */
export async function loadDashboardOriginPills(
  database: OriginPillsDatabase,
  companyId: number,
): Promise<DashboardOriginPills> {
  const [rows, [settingsRow]] = await Promise.all([
    database
      .selectDistinct({
        trackingSource: recoveryLeads.trackingSource,
        platform: recoveryLeads.platform,
        utmMedium: recoveryLeads.utmMedium,
        eventType: recoveryLeads.eventType,
        channel: recoveryLeads.channel,
      })
      .from(recoveryLeads)
      .where(eq(recoveryLeads.companyId, companyId)),
    database
      .select({ hotmartEnabled: settings.hotmartEnabled })
      .from(settings)
      .where(eq(settings.companyId, companyId)),
  ])

  const disabledCheckouts = new Set<DashboardOriginKey>()
  if (settingsRow?.hotmartEnabled === false) disabledCheckouts.add('hotmart')

  return buildDashboardOriginPills(rows, { disabledCheckouts })
}

export function hasDashboardOrigin(
  pills: DashboardOriginPills,
  category: DashboardOriginKey,
): boolean {
  return pills.categories.has(category)
}
