export const dynamic = 'force-dynamic'

import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, and, gte, lte, sql, desc, inArray } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { resolvePeriod } from '@/lib/period'
import { Suspense } from 'react'
import { Users, DollarSign, ShoppingBag, TrendingUp, WifiOff } from 'lucide-react'
import { VendasFilters } from './vendas-filters'
import { MobileRowCard } from '@/components/ui/mobile-row-card'

const PAYMENT_LABELS: Record<string, string> = {
  credit_card: 'Cartão',
  boleto: 'Boleto',
  pix: 'PIX',
  debit_card: 'Débito',
  paypal: 'PayPal',
}

const PAYMENT_VAR: Record<string, string> = {
  credit_card: 'var(--ev-cartao)',
  boleto: 'var(--ev-boleto)',
  pix: 'var(--ev-pix)',
  debit_card: 'var(--ev-cartao)',
  paypal: 'var(--st-info)',
}

const PLATFORM_LABELS: Record<string, string> = {
  hotmart: 'Hotmart',
  greenn: 'Greenn',
  zouti: 'Zouti',
  kiwify: 'Kiwify',
}

const PLATFORM_VAR: Record<string, string> = {
  hotmart: 'var(--plat-hotmart)',
  greenn: 'var(--plat-greenn)',
  zouti: 'var(--plat-zouti)',
  kiwify: 'var(--plat-kiwify)',
}

const TH = 'px-5 h-10 text-left text-label uppercase text-fg-subtle whitespace-nowrap'

/** Moeda com R$ e centavos subordinados ao inteiro, para o número principal saltar */
function Money({ cents, className }: { cents: number; className?: string }) {
  const value = (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  const [inteiro, centavos] = value.split(',')
  return (
    <p className={`num ${className ?? ''}`}>
      <span className="num-affix">R$ </span>
      {inteiro}
      <span className="num-affix">,{centavos}</span>
    </p>
  )
}

interface PageProps {
  searchParams: Promise<{
    period?: string
    from?: string
    to?: string
    products?: string
    payment?: string
    platform?: string
    utmSource?: string
    utmMedium?: string
    utmCampaign?: string
    utmContent?: string
    utmTerm?: string
    sck?: string
  }>
}

export default async function AnalyticsVendasPage({ searchParams }: PageProps) {
  const [company, params] = await Promise.all([requireCompany(), searchParams])
  const cid = company.id

  const { from, to } = resolvePeriod(params)
  const fromDate = new Date(`${from}T00:00:00-03:00`)
  const toDate = new Date(`${to}T23:59:59.999-03:00`)

  const baseConditions = [
    eq(recoveryLeads.companyId, cid),
    eq(recoveryLeads.eventType, 'compra_aprovada'),
    gte(recoveryLeads.createdAt, fromDate),
    lte(recoveryLeads.createdAt, toDate),
  ]

  const selectedProducts = params.products ? params.products.split(',').filter(Boolean) : []
  if (selectedProducts.length > 0) baseConditions.push(inArray(recoveryLeads.productName, selectedProducts))
  if (params.payment) baseConditions.push(eq(recoveryLeads.paymentType, params.payment))
  if (params.platform)    baseConditions.push(eq(recoveryLeads.platform, params.platform))
  if (params.utmSource)   baseConditions.push(eq(recoveryLeads.trackingSource, params.utmSource))
  if (params.utmMedium)   baseConditions.push(eq(recoveryLeads.utmMedium, params.utmMedium))
  if (params.utmCampaign) baseConditions.push(eq(recoveryLeads.utmCampaign, params.utmCampaign))
  if (params.utmContent)  baseConditions.push(eq(recoveryLeads.utmContent, params.utmContent))
  if (params.utmTerm)     baseConditions.push(eq(recoveryLeads.utmTerm, params.utmTerm))
  if (params.sck)         baseConditions.push(eq(recoveryLeads.trackingSourceSck, params.sck))

  const whereClause = and(...baseConditions)

  // Para popular dropdowns de filtro: sem filtros de UTM/platform (mostra todas as opções disponíveis)
  const baseForOptions = and(
    eq(recoveryLeads.companyId, cid),
    eq(recoveryLeads.eventType, 'compra_aprovada'),
  )

  const [
    sales,
    productStats,
    summaryRow,
    availableProducts,
    utmSourceStats,
    utmCampaignStats,
    utmSckStats,
    distinctUtmSources,
    distinctUtmMediums,
    distinctUtmCampaigns,
    distinctUtmContents,
    distinctUtmTerms,
    distinctSck,
  ] = await Promise.all([
    // Tabela de compradores
    db
      .select({
        id: recoveryLeads.id,
        name: recoveryLeads.name,
        email: recoveryLeads.email,
        phone: recoveryLeads.phone,
        platform: recoveryLeads.platform,
        productName: recoveryLeads.productName,
        productValue: recoveryLeads.productValue,
        paymentType: recoveryLeads.paymentType,
        installments: recoveryLeads.installments,
        trackingSource: recoveryLeads.trackingSource,
        utmMedium: recoveryLeads.utmMedium,
        utmCampaign: recoveryLeads.utmCampaign,
        utmContent: recoveryLeads.utmContent,
        utmTerm: recoveryLeads.utmTerm,
        trackingSourceSck: recoveryLeads.trackingSourceSck,
        createdAt: recoveryLeads.createdAt,
      })
      .from(recoveryLeads)
      .where(whereClause)
      .orderBy(desc(recoveryLeads.createdAt))
      .limit(500),

    // Breakdown por produto
    db
      .select({
        productName: recoveryLeads.productName,
        count: sql<number>`cast(count(*) as int)`,
        revenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}), 0) as bigint)`,
        avgTicket: sql<number>`cast(coalesce(avg(${recoveryLeads.productValue}), 0) as numeric(18,2))`,
      })
      .from(recoveryLeads)
      .where(whereClause)
      .groupBy(recoveryLeads.productName)
      .orderBy(desc(sql<number>`count(*)`))
      .limit(20),

    // Resumo geral com breakdown por plataforma e UTM
    db
      .select({
        total: sql<number>`cast(count(*) as int)`,
        revenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}), 0) as bigint)`,
        avgTicket: sql<number>`cast(coalesce(avg(${recoveryLeads.productValue}), 0) as numeric(18,2))`,
        uniqueClients: sql<number>`cast(count(distinct ${recoveryLeads.email}) as int)`,
        hotmartCount: sql<number>`cast(count(*) filter (where ${recoveryLeads.platform} = 'hotmart') as int)`,
        hotmartRevenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.platform} = 'hotmart'), 0) as bigint)`,
        greennCount: sql<number>`cast(count(*) filter (where ${recoveryLeads.platform} = 'greenn') as int)`,
        greennRevenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.platform} = 'greenn'), 0) as bigint)`,
        zoutiCount: sql<number>`cast(count(*) filter (where ${recoveryLeads.platform} = 'zouti') as int)`,
        zoutiRevenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.platform} = 'zouti'), 0) as bigint)`,
        kiwifyCount: sql<number>`cast(count(*) filter (where ${recoveryLeads.platform} = 'kiwify') as int)`,
        kiwifyRevenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.platform} = 'kiwify'), 0) as bigint)`,
        withUtm: sql<number>`cast(count(*) filter (where ${recoveryLeads.trackingSource} is not null) as int)`,
        topUtmSource: sql<string>`(select ${recoveryLeads.trackingSource} from ${recoveryLeads} where ${recoveryLeads.companyId} = ${cid} and ${recoveryLeads.eventType} = 'compra_aprovada' and ${recoveryLeads.trackingSource} is not null group by ${recoveryLeads.trackingSource} order by sum(${recoveryLeads.productValue}) desc nulls last limit 1)`,
        topUtmRevenue: sql<number>`cast((select coalesce(sum(${recoveryLeads.productValue}),0) from ${recoveryLeads} where ${recoveryLeads.companyId} = ${cid} and ${recoveryLeads.eventType} = 'compra_aprovada' and ${recoveryLeads.trackingSource} is not null group by ${recoveryLeads.trackingSource} order by sum(${recoveryLeads.productValue}) desc nulls last limit 1) as bigint)`,
      })
      .from(recoveryLeads)
      .where(whereClause),

    // Produtos disponíveis para filtro
    db
      .selectDistinct({ productName: recoveryLeads.productName, platform: recoveryLeads.platform })
      .from(recoveryLeads)
      .where(baseForOptions)
      .orderBy(recoveryLeads.productName)
      .limit(100),

    // Breakdown UTM Source
    db
      .select({
        source: recoveryLeads.trackingSource,
        count: sql<number>`cast(count(*) as int)`,
        revenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}), 0) as bigint)`,
        avgTicket: sql<number>`cast(coalesce(avg(${recoveryLeads.productValue}), 0) as numeric(18,2))`,
      })
      .from(recoveryLeads)
      .where(and(...baseConditions, sql`${recoveryLeads.trackingSource} is not null`))
      .groupBy(recoveryLeads.trackingSource)
      .orderBy(desc(sql<number>`sum(${recoveryLeads.productValue})`))
      .limit(20),

    // Breakdown UTM Campaign
    db
      .select({
        campaign: recoveryLeads.utmCampaign,
        count: sql<number>`cast(count(*) as int)`,
        revenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}), 0) as bigint)`,
        avgTicket: sql<number>`cast(coalesce(avg(${recoveryLeads.productValue}), 0) as numeric(18,2))`,
      })
      .from(recoveryLeads)
      .where(and(...baseConditions, sql`${recoveryLeads.utmCampaign} is not null`))
      .groupBy(recoveryLeads.utmCampaign)
      .orderBy(desc(sql<number>`sum(${recoveryLeads.productValue})`))
      .limit(20),

    // Breakdown SCK
    db
      .select({
        sck: recoveryLeads.trackingSourceSck,
        count: sql<number>`cast(count(*) as int)`,
        revenue: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}), 0) as bigint)`,
      })
      .from(recoveryLeads)
      .where(and(...baseConditions, sql`${recoveryLeads.trackingSourceSck} is not null`))
      .groupBy(recoveryLeads.trackingSourceSck)
      .orderBy(desc(sql<number>`sum(${recoveryLeads.productValue})`))
      .limit(20),

    // Distinct values para filtros
    db.selectDistinct({ val: recoveryLeads.trackingSource })
      .from(recoveryLeads).where(and(baseForOptions, sql`${recoveryLeads.trackingSource} is not null`))
      .orderBy(recoveryLeads.trackingSource).limit(50),

    db.selectDistinct({ val: recoveryLeads.utmMedium })
      .from(recoveryLeads).where(and(baseForOptions, sql`${recoveryLeads.utmMedium} is not null`))
      .orderBy(recoveryLeads.utmMedium).limit(50),

    db.selectDistinct({ val: recoveryLeads.utmCampaign })
      .from(recoveryLeads).where(and(baseForOptions, sql`${recoveryLeads.utmCampaign} is not null`))
      .orderBy(recoveryLeads.utmCampaign).limit(50),

    db.selectDistinct({ val: recoveryLeads.utmContent })
      .from(recoveryLeads).where(and(baseForOptions, sql`${recoveryLeads.utmContent} is not null`))
      .orderBy(recoveryLeads.utmContent).limit(50),

    db.selectDistinct({ val: recoveryLeads.utmTerm })
      .from(recoveryLeads).where(and(baseForOptions, sql`${recoveryLeads.utmTerm} is not null`))
      .orderBy(recoveryLeads.utmTerm).limit(50),

    db.selectDistinct({ val: recoveryLeads.trackingSourceSck })
      .from(recoveryLeads).where(and(baseForOptions, sql`${recoveryLeads.trackingSourceSck} is not null`))
      .orderBy(recoveryLeads.trackingSourceSck).limit(50),
  ])

  const s = summaryRow[0]
  const totalRevenue = Number(s?.revenue ?? 0)
  const avgTicket = Number(s?.avgTicket ?? 0)
  const totalSales = s?.total ?? 0
  const uniqueClients = s?.uniqueClients ?? 0
  const withUtm = s?.withUtm ?? 0
  const withoutUtm = totalSales - withUtm
  const utmRate = totalSales > 0 ? Math.round((withUtm / totalSales) * 100) : 0
  const hotmartRevenue = Number(s?.hotmartRevenue ?? 0)
  const greennRevenue = Number(s?.greennRevenue ?? 0)
  const zoutiRevenue = Number(s?.zoutiRevenue ?? 0)
  const kiwifyRevenue = Number(s?.kiwifyRevenue ?? 0)
  const hotmartCount = s?.hotmartCount ?? 0
  const greennCount = s?.greennCount ?? 0
  const zoutiCount = s?.zoutiCount ?? 0
  const kiwifyCount = s?.kiwifyCount ?? 0
  const topUtmSource = s?.topUtmSource ?? null
  const topUtmRevenue = Number(s?.topUtmRevenue ?? 0)

  const PLATFORM_VALUES = ['hotmart', 'greenn', 'zouti', 'kiwify'] as const
  type ProductPlatform = (typeof PLATFORM_VALUES)[number] | null
  const products = availableProducts
    .map((p) => ({
      name: p.productName,
      platform: (PLATFORM_VALUES as readonly string[]).includes(p.platform ?? '')
        ? (p.platform as ProductPlatform)
        : null,
    }))
    .filter((p): p is { name: string; platform: ProductPlatform } => Boolean(p.name))
  const utmSourceOptions   = distinctUtmSources.map((r) => r.val).filter(Boolean) as string[]
  const utmMediumOptions   = distinctUtmMediums.map((r) => r.val).filter(Boolean) as string[]
  const utmCampaignOptions = distinctUtmCampaigns.map((r) => r.val).filter(Boolean) as string[]
  const utmContentOptions  = distinctUtmContents.map((r) => r.val).filter(Boolean) as string[]
  const utmTermOptions     = distinctUtmTerms.map((r) => r.val).filter(Boolean) as string[]
  const sckOptions         = distinctSck.map((r) => r.val).filter(Boolean) as string[]

  const fmt = (cents: number) =>
    (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

  // Participação por plataforma: uma barra empilhada, não quatro barras soltas
  const platformRows = [
    { key: 'hotmart', label: 'Hotmart', color: PLATFORM_VAR.hotmart, count: hotmartCount, revenue: hotmartRevenue },
    { key: 'greenn',  label: 'Greenn',  color: PLATFORM_VAR.greenn,  count: greennCount,  revenue: greennRevenue },
    { key: 'zouti',   label: 'Zouti',   color: PLATFORM_VAR.zouti,   count: zoutiCount,   revenue: zoutiRevenue },
    { key: 'kiwify',  label: 'Kiwify',  color: PLATFORM_VAR.kiwify,  count: kiwifyCount,  revenue: kiwifyRevenue },
  ].filter((p) => p.count > 0)

  return (
    <div className="space-y-4">
      <div className="rise rise-1">
        <h1 className="text-h1 text-fg">Analytics Vendas</h1>
        <p className="text-body text-fg-muted mt-1">Receita, clientes e atribuição de campanhas</p>
      </div>

      {/* Filtros: uma linha só, o resto vive no painel lateral */}
      <div className="card-section p-3 rise rise-1">
        <Suspense fallback={null}>
          <VendasFilters
            from={from}
            to={to}
            products={products}
            utmSources={utmSourceOptions}
            utmMediums={utmMediumOptions}
            utmCampaigns={utmCampaignOptions}
            utmContents={utmContentOptions}
            utmTerms={utmTermOptions}
            sckValues={sckOptions}
          />
        </Suspense>
      </div>

      {/* KPIs principais */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 rise rise-2">
        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-label uppercase text-fg-subtle">Vendas</p>
            <ShoppingBag size={15} className="text-fg-faint" />
          </div>
          <p className="num text-metric text-fg">{totalSales}</p>
          <p className="text-micro text-fg-subtle mt-2">transações aprovadas</p>
        </div>

        <div className="card-highlight p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-label uppercase text-fg-subtle">Receita</p>
            <DollarSign size={15} className="text-brand" />
          </div>
          {/*
            No celular este card ocupa meia tela, e o piso de 40px do text-display
            corta valor de cinco dígitos, porque o .card-highlight tem overflow
            escondido. A escala maior só entra quando há largura para ela.
          */}
          <Money cents={totalRevenue} className="text-metric sm:text-display text-brand-ink" />
          <p className="text-micro text-fg-subtle mt-2">no período selecionado</p>
        </div>

        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-label uppercase text-fg-subtle">Ticket médio</p>
            <TrendingUp size={15} className="text-fg-faint" />
          </div>
          <Money cents={avgTicket} className="text-metric text-fg" />
          <p className="text-micro text-fg-subtle mt-2">por compra</p>
        </div>

        <div className="card p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-label uppercase text-fg-subtle">Clientes</p>
            <Users size={15} className="text-fg-faint" />
          </div>
          <p className="num text-metric text-fg">{uniqueClients}</p>
          <p className="text-micro text-fg-subtle mt-2">emails únicos</p>
        </div>
      </div>

      {/* Participação por plataforma, rastreamento e melhor origem */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3 rise rise-3">
        <div className="card-section p-5">
          <p className="text-label uppercase text-fg-subtle mb-4">Plataformas</p>
          {platformRows.length > 0 ? (
            <>
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-inset">
                {platformRows.map((p) => (
                  <div
                    key={p.key}
                    style={{
                      width: `${totalSales > 0 ? (p.count / totalSales) * 100 : 0}%`,
                      background: p.color,
                    }}
                  />
                ))}
              </div>
              <ul className="mt-4 space-y-2.5">
                {platformRows.map((p) => (
                  <li key={p.key} className="flex items-center gap-2">
                    <span className="dot" style={{ color: p.color }} />
                    <span className="text-micro text-fg-muted flex-1 truncate">{p.label}</span>
                    <span className="num text-micro text-fg">{fmt(p.revenue)}</span>
                    <span className="num text-micro text-fg-subtle w-16 text-right">
                      {p.count} · {totalSales > 0 ? Math.round((p.count / totalSales) * 100) : 0}%
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-body text-fg-subtle">Nenhuma venda no período</p>
          )}
        </div>

        <div className="card-section p-5">
          <p className="text-label uppercase text-fg-subtle mb-4">Rastreamento UTM</p>
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-inset">
            <div style={{ width: `${utmRate}%`, background: 'var(--brand)' }} />
          </div>
          <ul className="mt-4 space-y-2.5">
            <li className="flex items-center gap-2">
              <span className="dot" style={{ color: 'var(--brand)' }} />
              <span className="text-micro text-fg-muted flex-1">Com UTM</span>
              <span className="num text-micro text-fg">{withUtm}</span>
              <span className="num text-micro text-fg-subtle w-12 text-right">{utmRate}%</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="dot" style={{ color: 'var(--fg-faint)' }} />
              <span className="text-micro text-fg-muted flex-1">Sem UTM</span>
              <span className="num text-micro text-fg">{withoutUtm}</span>
              <span className="num text-micro text-fg-subtle w-12 text-right">{100 - utmRate}%</span>
            </li>
          </ul>
        </div>

        <div className="card-section p-5">
          <p className="text-label uppercase text-fg-subtle mb-4">Melhor UTM Source</p>
          {topUtmSource ? (
            <div className="space-y-2">
              <p className="num text-micro text-fg-muted truncate" title={topUtmSource}>
                {topUtmSource}
              </p>
              <Money cents={topUtmRevenue} className="text-metric-sm text-brand-ink" />
              <p className="text-micro text-fg-subtle">maior receita no período</p>
            </div>
          ) : (
            <div className="flex h-16 flex-col items-center justify-center gap-1">
              <WifiOff size={20} className="text-fg-faint" />
              <p className="text-micro text-fg-subtle">Nenhum UTM rastreado</p>
            </div>
          )}
        </div>
      </div>

      {/* Receita por UTM Campaign */}
      {utmCampaignStats.length > 0 && (
        <div className="card-section overflow-hidden rise rise-4">
          <div className="border-b border-line-subtle px-5 py-4">
            <h2 className="text-h2 text-fg">Receita por UTM Campaign</h2>
            <p className="text-micro text-fg-subtle mt-0.5">Campanhas ordenadas por receita gerada</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line-default">
                  {['Campanha', 'Vendas', 'Receita', 'Ticket médio', '% do total'].map((col) => (
                    <th key={col} className={TH}>{col}</th>
                  ))}
                  <th className="w-full" />
                </tr>
              </thead>
              <tbody>
                {utmCampaignStats.map((row) => {
                  const revPct = totalRevenue > 0 ? (Number(row.revenue) / totalRevenue) * 100 : 0
                  return (
                    <tr key={row.campaign} className="h-12 border-b border-line-subtle tr-hover">
                      <td className="max-w-[280px] px-5 text-body text-fg-muted">
                        <span className="num block truncate text-micro" title={row.campaign ?? undefined}>{row.campaign}</span>
                      </td>
                      <td className="num px-5 text-body text-fg">{row.count}</td>
                      <td className="num whitespace-nowrap px-5 text-body text-brand-ink">{fmt(Number(row.revenue))}</td>
                      <td className="num whitespace-nowrap px-5 text-body text-fg-muted">{fmt(Number(row.avgTicket))}</td>
                      <td className="px-5">
                        <div className="flex items-center gap-2">
                          <div className="progress-bar w-20">
                            <div className="progress-fill" style={{ width: `${revPct}%`, background: 'var(--st-info)' }} />
                          </div>
                          <span className="num text-micro text-fg-subtle">{revPct.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td />
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Receita por UTM Source e por SCK */}
      {(utmSourceStats.length > 0 || utmSckStats.length > 0) && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 rise rise-4">
          {utmSourceStats.length > 0 && (
            <div className="card-section overflow-hidden">
              <div className="border-b border-line-subtle px-5 py-4">
                <h2 className="text-h2 text-fg">Receita por UTM Source</h2>
                <p className="text-micro text-fg-subtle mt-0.5">Ordenado por receita gerada</p>
              </div>
              <div className="space-y-3 p-5">
                {utmSourceStats.map((row) => {
                  const revPct = totalRevenue > 0 ? Math.round((Number(row.revenue) / totalRevenue) * 100) : 0
                  return (
                    <div key={row.source} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="num max-w-[160px] truncate text-micro text-fg-muted" title={row.source ?? undefined}>
                          {row.source}
                        </span>
                        <div className="flex shrink-0 items-center gap-3">
                          <span className="num text-micro text-fg-subtle">{row.count} vendas</span>
                          <span className="num w-24 text-right text-micro text-brand-ink">{fmt(Number(row.revenue))}</span>
                        </div>
                      </div>
                      <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${revPct}%`, background: 'var(--brand)' }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {utmSckStats.length > 0 && (
            <div className="card-section overflow-hidden">
              <div className="border-b border-line-subtle px-5 py-4">
                <h2 className="text-h2 text-fg">Receita por SCK</h2>
                <p className="text-micro text-fg-subtle mt-0.5">Ordenado por receita gerada</p>
              </div>
              <div className="space-y-3 p-5">
                {utmSckStats.map((row) => {
                  const revPct = totalRevenue > 0 ? Math.round((Number(row.revenue) / totalRevenue) * 100) : 0
                  return (
                    <div key={row.sck} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <span className="num max-w-[160px] truncate text-micro text-fg-muted" title={row.sck ?? undefined}>
                          {row.sck}
                        </span>
                        <div className="flex shrink-0 items-center gap-3">
                          <span className="num text-micro text-fg-subtle">{row.count} vendas</span>
                          <span className="num w-24 text-right text-micro text-st-info">{fmt(Number(row.revenue))}</span>
                        </div>
                      </div>
                      <div className="progress-bar">
                        <div className="progress-fill" style={{ width: `${revPct}%`, background: 'var(--st-info)' }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Vendas por produto */}
      {productStats.length > 0 && (
        <div className="card-section overflow-hidden rise rise-5">
          <div className="border-b border-line-subtle px-5 py-4">
            <h2 className="text-h2 text-fg">Vendas por produto</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-line-default">
                  {['Produto', 'Qtd vendas', 'Receita', 'Ticket médio', '% do total'].map((col) => (
                    <th key={col} className={TH}>{col}</th>
                  ))}
                  <th className="w-full" />
                </tr>
              </thead>
              <tbody>
                {productStats.map((row) => {
                  const pct = totalSales > 0 ? ((row.count / totalSales) * 100).toFixed(1) : '0.0'
                  const revPct = totalRevenue > 0 ? (Number(row.revenue) / totalRevenue) * 100 : 0
                  return (
                    <tr key={row.productName} className="h-12 border-b border-line-subtle tr-hover">
                      <td className="max-w-[280px] px-5">
                        <span className="block truncate text-body text-fg" title={row.productName ?? undefined}>
                          {row.productName ?? 'Sem nome'}
                        </span>
                      </td>
                      <td className="num px-5 text-body text-fg">{row.count}</td>
                      <td className="num whitespace-nowrap px-5 text-body text-brand-ink">{fmt(Number(row.revenue))}</td>
                      <td className="num whitespace-nowrap px-5 text-body text-fg-muted">{fmt(Number(row.avgTicket))}</td>
                      <td className="px-5">
                        <div className="flex items-center gap-2">
                          <div className="progress-bar w-20">
                            <div className="progress-fill" style={{ width: `${revPct}%`, background: 'var(--brand)' }} />
                          </div>
                          <span className="num whitespace-nowrap text-micro text-fg-subtle">{pct}%</span>
                        </div>
                      </td>
                      <td />
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Compradores */}
      <div className="card-section overflow-hidden rise rise-6">
        <div className="flex items-center justify-between border-b border-line-subtle px-5 py-4">
          <h2 className="text-h2 text-fg">Compradores</h2>
          <span className="num text-micro text-fg-subtle">{sales.length} registros</span>
        </div>

        {/* Celular: cada comprador vira um card, com rastreamento recolhido */}
        <div className="space-y-2 p-3 md:hidden">
          {sales.length === 0 && (
            <p className="py-8 text-center text-body text-fg-subtle">
              Nenhuma venda encontrada no período selecionado
            </p>
          )}
          {sales.map((sale) => (
            <MobileRowCard
              key={sale.id}
              title={sale.name ?? '-'}
              subtitle={
                <span className="num">
                  {sale.email ?? '-'}
                  {sale.phone ? ` · ${sale.phone}` : ''}
                </span>
              }
              meta={
                <>
                  <span className="num text-brand-ink">
                    {sale.productValue ? fmt(sale.productValue) : '-'}
                  </span>
                  {(sale.installments ?? 0) > 1 && (
                    <span className="num text-fg-subtle">{sale.installments}x</span>
                  )}
                  <span className="max-w-[55%] truncate text-fg-muted">{sale.productName ?? '-'}</span>
                  <span className="num text-fg-subtle">
                    {sale.createdAt
                      ? new Date(sale.createdAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' })
                      : '-'}
                  </span>
                </>
              }
              badges={
                <>
                  {sale.platform && (
                    <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                      <span className="dot" style={{ color: PLATFORM_VAR[sale.platform] ?? 'var(--fg-faint)' }} />
                      {PLATFORM_LABELS[sale.platform] ?? sale.platform}
                    </span>
                  )}
                  {sale.paymentType && (
                    <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                      <span className="dot" style={{ color: PAYMENT_VAR[sale.paymentType] ?? 'var(--fg-faint)' }} />
                      {PAYMENT_LABELS[sale.paymentType] ?? sale.paymentType}
                    </span>
                  )}
                </>
              }
            >
              <details className="mt-3 border-t border-line-subtle pt-2">
                <summary className="cursor-pointer list-none py-1 text-micro text-fg-subtle">
                  Ver rastreamento
                </summary>
                <dl className="num mt-2 space-y-1 text-micro">
                  {([
                    ['Source', sale.trackingSource],
                    ['Medium', sale.utmMedium],
                    ['Campaign', sale.utmCampaign],
                    ['Term', sale.utmTerm],
                    ['sck', sale.trackingSourceSck],
                  ] as [string, string | null][]).map(([label, value]) => (
                    <div key={label} className="flex gap-2">
                      <dt className="w-20 shrink-0 text-fg-faint">{label}</dt>
                      <dd className="truncate text-fg-muted">{value ?? '-'}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            </MobileRowCard>
          ))}
        </div>

        {/* Desktop: tabela */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line-default">
                {['Nome', 'Email', 'Telefone', 'Plataforma', 'Produto', 'Valor', 'Pagamento', 'UTM Source', 'UTM Medium', 'UTM Campaign', 'UTM Term', 'Data'].map((col) => (
                  <th key={col} className={TH}>{col}</th>
                ))}
                <th className="w-full" />
              </tr>
            </thead>
            <tbody>
              {sales.length === 0 && (
                <tr>
                  <td colSpan={13} className="px-5 py-12 text-center text-body text-fg-subtle">
                    Nenhuma venda encontrada no período selecionado
                  </td>
                </tr>
              )}
              {sales.map((sale) => (
                <tr key={sale.id} className="h-12 border-b border-line-subtle tr-hover">
                  <td className="max-w-[280px] px-5">
                    <span className="block truncate text-body text-fg" title={sale.name ?? undefined}>{sale.name ?? '-'}</span>
                  </td>
                  <td className="max-w-[180px] px-5">
                    <span className="num block truncate text-micro text-fg-muted" title={sale.email ?? undefined}>{sale.email ?? '-'}</span>
                  </td>
                  <td className="num whitespace-nowrap px-5 text-micro text-fg-muted">{sale.phone ?? '-'}</td>
                  <td className="whitespace-nowrap px-5">
                    {sale.platform ? (
                      <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                        <span className="dot" style={{ color: PLATFORM_VAR[sale.platform] ?? 'var(--fg-faint)' }} />
                        {PLATFORM_LABELS[sale.platform] ?? sale.platform}
                      </span>
                    ) : <span className="text-fg-faint">-</span>}
                  </td>
                  <td className="max-w-[160px] px-5">
                    <span className="block truncate text-micro text-fg-muted" title={sale.productName ?? undefined}>{sale.productName ?? '-'}</span>
                  </td>
                  <td className="num whitespace-nowrap px-5 text-body text-brand-ink">
                    {sale.productValue ? fmt(sale.productValue) : '-'}
                    {sale.installments && sale.installments > 1 && (
                      <span className="num ml-1 text-micro text-fg-subtle">{sale.installments}x</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-5">
                    {sale.paymentType ? (
                      <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                        <span className="dot" style={{ color: PAYMENT_VAR[sale.paymentType] ?? 'var(--fg-faint)' }} />
                        {PAYMENT_LABELS[sale.paymentType] ?? sale.paymentType}
                      </span>
                    ) : <span className="text-fg-faint">-</span>}
                  </td>
                  <td className="max-w-[110px] px-5">
                    <span className="num block truncate text-micro text-fg-muted" title={sale.trackingSource ?? undefined}>
                      {sale.trackingSource ?? <span className="text-fg-faint">-</span>}
                    </span>
                  </td>
                  <td className="max-w-[110px] px-5">
                    <span className="num block truncate text-micro text-fg-muted" title={sale.utmMedium ?? undefined}>
                      {sale.utmMedium ?? <span className="text-fg-faint">-</span>}
                    </span>
                  </td>
                  <td className="max-w-[180px] px-5">
                    <span className="num block truncate text-micro text-fg-muted" title={sale.utmCampaign ?? undefined}>
                      {sale.utmCampaign ?? <span className="text-fg-faint">-</span>}
                    </span>
                  </td>
                  <td className="max-w-[110px] px-5">
                    <span className="num block truncate text-micro text-fg-muted" title={sale.utmTerm ?? undefined}>
                      {sale.utmTerm ?? <span className="text-fg-faint">-</span>}
                    </span>
                  </td>
                  <td className="num whitespace-nowrap px-5 text-micro text-fg-subtle">
                    {sale.createdAt ? new Date(sale.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '-'}
                  </td>
                  <td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
