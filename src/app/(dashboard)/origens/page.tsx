export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, and, gte, lte, sql, desc, count } from 'drizzle-orm'
import { resolvePeriod } from '@/lib/period'
import PeriodBar from '@/components/shared/PeriodBar'
import { Suspense } from 'react'
import {
  Globe,
  TrendingUp,
  Layers,
  ArrowUpRight,
  DollarSign,
  Users,
  ShoppingCart,
  Target,
  Sparkles,
  Zap,
  MessageSquare,
  Search,
  Radio,
  BarChart3,
  Flame,
  CheckCircle2
} from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string; period?: string }>
}

function formatBRL(cents: number): string {
  if (!cents || isNaN(cents)) return 'R$ 0,00'
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function normalizeSource(raw: string | null): { name: string; category: string; color: string; badgeColor: string } {
  if (!raw) {
    return { name: 'Direto / Orgânico', category: 'organico', color: 'bg-emerald-500', badgeColor: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' }
  }
  const s = raw.toLowerCase().trim()
  
  // 1. Mineração & Outreach Frio
  if (s.includes('miner') || s.includes('mining') || s.includes('outreach') || s.includes('fria') || s.includes('prospeccao') || s.includes('nina_outreach')) {
    return { name: 'Mineração (Outreach & Prospecção Fria)', category: 'mineracao', color: 'bg-cyan-500', badgeColor: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20' }
  }
  // 2. Anúncios Meta (Instagram / Facebook)
  if (s.includes('fb') || s.includes('ig') || s.includes('meta') || s.includes('instagram') || s.includes('facebook') || s.includes('nina_anuncio') || s.includes('anuncio')) {
    return { name: 'Anúncios Meta (Instagram & Facebook Ads)', category: 'meta_ads', color: 'bg-blue-500', badgeColor: 'text-blue-400 bg-blue-500/10 border-blue-500/20' }
  }
  // 3. Google Ads / YouTube
  if (s.includes('google') || s.includes('gads') || s.includes('youtube') || s.includes('yt') || s.includes('search')) {
    return { name: 'Google Ads & YouTube Search', category: 'google_ads', color: 'bg-amber-500', badgeColor: 'text-amber-400 bg-amber-500/10 border-amber-500/20' }
  }
  // 4. Plataformas de Checkout (Hotmart, Kiwify, Greenn, Zouti)
  if (s.includes('hotmart')) {
    return { name: 'Hotmart Checkout', category: 'checkout', color: 'bg-orange-500', badgeColor: 'text-orange-400 bg-orange-500/10 border-orange-500/20' }
  }
  if (s.includes('kiwify')) {
    return { name: 'Kiwify Checkout', category: 'checkout', color: 'bg-emerald-500', badgeColor: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' }
  }
  if (s.includes('greenn')) {
    return { name: 'Greenn Checkout', category: 'checkout', color: 'bg-lime-500', badgeColor: 'text-lime-400 bg-lime-500/10 border-lime-500/20' }
  }
  if (s.includes('zouti')) {
    return { name: 'Zouti Checkout', category: 'checkout', color: 'bg-purple-500', badgeColor: 'text-purple-400 bg-purple-500/10 border-purple-500/20' }
  }
  // 5. Instagram Direct
  if (s.includes('direct') || s.includes('ig_direct')) {
    return { name: 'Instagram Direct', category: 'instagram', color: 'bg-pink-500', badgeColor: 'text-pink-400 bg-pink-500/10 border-pink-500/20' }
  }
  // 6. E-mail Marketing
  if (s.includes('email') || s.includes('mail') || s.includes('newsletter') || s.includes('brevo')) {
    return { name: 'E-mail Marketing & Campanhas', category: 'email', color: 'bg-indigo-500', badgeColor: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20' }
  }

  return { name: raw, category: 'other', color: 'bg-zinc-500', badgeColor: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20' }
}

export default async function OrigensPage({ searchParams }: PageProps) {
  const [company, params] = await Promise.all([requireCompany(), searchParams])
  const cid = company.id

  const { from, to } = resolvePeriod(params)
  const fromDate = new Date(`${from}T00:00:00-03:00`)
  const toDate = new Date(`${to}T23:59:59.999-03:00`)

  const dateFilter = and(gte(recoveryLeads.createdAt, fromDate), lte(recoveryLeads.createdAt, toDate))
  const baseWhere = and(eq(recoveryLeads.companyId, cid), dateFilter)

  const [totalRow, rawOrigensRows] = await Promise.all([
    db
      .select({
        totalLeads: count(),
        recoveredCount: sql<number>`cast(count(*) filter (where ${recoveryLeads.status} = 'converted') as int)`,
        recoveredValueCents: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.status} = 'converted'), 0) as bigint)`,
      })
      .from(recoveryLeads)
      .where(baseWhere),

    db
      .select({
        rawSource: sql<string>`coalesce(nullif(${recoveryLeads.trackingSource}, ''), nullif(${recoveryLeads.platform}, ''), 'Direto / Orgânico')`,
        total: sql<number>`cast(count(*) as int)`,
        recovered: sql<number>`cast(count(*) filter (where ${recoveryLeads.status} = 'converted') as int)`,
        recoveredValueCents: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.status} = 'converted'), 0) as bigint)`,
      })
      .from(recoveryLeads)
      .where(baseWhere)
      .groupBy(sql`coalesce(nullif(${recoveryLeads.trackingSource}, ''), nullif(${recoveryLeads.platform}, ''), 'Direto / Orgânico')`)
      .orderBy(desc(sql<number>`count(*)`)),
  ])

  const totalLeads = totalRow[0]?.totalLeads ?? 0
  const totalRecovered = totalRow[0]?.recoveredCount ?? 0
  const totalRecoveredCents = Number(totalRow[0]?.recoveredValueCents ?? 0)
  const globalConvRate = totalLeads > 0 ? ((totalRecovered / totalLeads) * 100).toFixed(1) : '0.0'

  // Agrupamento normalizado das origens
  const origensMap = new Map<string, {
    name: string
    category: string
    color: string
    badgeColor: string
    leads: number
    recovered: number
    recoveredValueCents: number
  }>()

  for (const row of rawOrigensRows) {
    const meta = normalizeSource(row.rawSource)
    const existing = origensMap.get(meta.name) ?? {
      name: meta.name,
      category: meta.category,
      color: meta.color,
      badgeColor: meta.badgeColor,
      leads: 0,
      recovered: 0,
      recoveredValueCents: 0,
    }
    existing.leads += row.total
    existing.recovered += row.recovered
    existing.recoveredValueCents += Number(row.recoveredValueCents)
    origensMap.set(meta.name, existing)
  }

  const origensList = Array.from(origensMap.values())
    .map((item) => {
      const share = totalLeads > 0 ? ((item.leads / totalLeads) * 100).toFixed(1) : '0.0'
      const conversao = item.leads > 0 ? ((item.recovered / item.leads) * 100).toFixed(1) : '0.0'
      return {
        ...item,
        share: `${share}%`,
        shareNum: Number(share),
        conversao: `${conversao}%`,
        recuperado: formatBRL(item.recoveredValueCents),
      }
    })
    .sort((a, b) => b.leads - a.leads)

  const topOrigin = origensList[0]?.name ?? 'Nenhuma ainda'

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      {/* 1. Cabeçalho com Empresa & PeriodBar Oficial */}
      <div className="rise rise-1 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
                <Globe size={12} />
                Empresa: {company.name}
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-fg-subtle bg-surface-inset px-2.5 py-0.5 rounded-full border border-line-subtle">
                Multicanal & Origens
              </span>
            </div>
            <h1 className="text-h1 text-fg">Origens de Tráfego & Aquisição</h1>
            <p className="text-body text-fg-muted mt-0.5">
              Rastreamento de onde chegam os leads (<strong>Mineração</strong>, <strong>Meta Ads</strong>, <strong>Google</strong>, <strong>Checkouts</strong> e <strong>Orgânico</strong>) e qual canal gera maior faturamento.
            </p>
          </div>
          <Suspense fallback={null}>
            <PeriodBar from={from} to={to} />
          </Suspense>
        </div>
      </div>

      {/* 2. 4 Cards de Métricas e KPIs de Aquisição */}
      <div className="rise rise-2 grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Card 1: Total Leads */}
        <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-label uppercase text-fg-subtle font-semibold">Total de Leads</span>
            <div className="h-7 w-7 rounded-[var(--r-md)] bg-surface-inset flex items-center justify-center text-fg-muted">
              <Users size={15} />
            </div>
          </div>
          <div className="mt-3">
            <span className="num text-metric text-fg font-bold">{totalLeads}</span>
            <p className="mt-0.5 text-micro text-fg-subtle">
              no período selecionado
            </p>
          </div>
        </div>

        {/* Card 2: Origem Campeã */}
        <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-label uppercase text-fg-subtle font-semibold">Origem Campeã</span>
            <div className="h-7 w-7 rounded-[var(--r-md)] bg-cyan-500/10 flex items-center justify-center text-cyan-400">
              <Flame size={15} />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-h3 font-bold text-fg truncate block" title={topOrigin}>
              {topOrigin}
            </span>
            <p className="mt-0.5 text-micro text-cyan-400 font-medium">
              maior volume captado
            </p>
          </div>
        </div>

        {/* Card 3: Taxa de Conversão */}
        <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-label uppercase text-fg-subtle font-semibold">Conversão Geral</span>
            <div className="h-7 w-7 rounded-[var(--r-md)] bg-emerald-500/10 flex items-center justify-center text-emerald-400">
              <TrendingUp size={15} />
            </div>
          </div>
          <div className="mt-3">
            <span className="num text-metric text-emerald-400 font-bold">{globalConvRate}%</span>
            <p className="mt-0.5 text-micro text-fg-subtle">
              {totalRecovered} vendas convertidas
            </p>
          </div>
        </div>

        {/* Card 4: Faturamento Recuperado */}
        <div className="panel p-4 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-label uppercase text-fg-subtle font-semibold">Receita Total</span>
            <div className="h-7 w-7 rounded-[var(--r-md)] bg-brand-ink/10 flex items-center justify-center text-brand-ink">
              <DollarSign size={15} />
            </div>
          </div>
          <div className="mt-3">
            <span className="num text-metric-sm text-brand-ink font-bold">
              {formatBRL(totalRecoveredCents)}
            </span>
            <p className="mt-0.5 text-micro text-fg-subtle">
              atribuída aos canais
            </p>
          </div>
        </div>
      </div>

      {/* 3. Grade de Origens e Canais */}
      <div className="rise rise-3 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-h2 text-fg">Distribuição por Canal de Origem</h2>
          <span className="num text-micro text-fg-subtle">{origensList.length} canais ativos</span>
        </div>

        {origensList.length === 0 ? (
          <div className="rounded-[var(--r-lg)] border border-dashed border-line-default bg-surface-panel p-10 text-center space-y-2">
            <div className="h-10 w-10 mx-auto rounded-full bg-surface-inset flex items-center justify-center text-fg-faint">
              <Target size={20} />
            </div>
            <p className="text-body font-medium text-fg">Nenhum dado de tráfego no período selecionado</p>
            <p className="text-micro text-fg-subtle max-w-md mx-auto">
              Assim que novos contatos de <strong>Mineração</strong> (Outreach), <strong>Anúncios Meta</strong> ou <strong>Webhooks de Plataformas</strong> forem processados, os canais aparecerão aqui automaticamente.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {origensList.map((origem) => (
              <div
                key={origem.name}
                className="panel p-5 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel flex flex-col justify-between space-y-4 hover:border-line-default transition-all"
              >
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-[11px] font-bold px-2.5 py-0.5 rounded-full border ${origem.badgeColor}`}>
                      {origem.category === 'mineracao' ? '⛏️ Mineração Fria' : origem.category.toUpperCase()}
                    </span>
                    <span className="num text-h3 font-bold text-fg">{origem.share}</span>
                  </div>

                  <h3 className="text-h3 text-fg font-bold mt-2.5 truncate" title={origem.name}>
                    {origem.name}
                  </h3>

                  <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden mt-3">
                    <div
                      className={`h-full ${origem.color} rounded-full transition-all duration-500`}
                      style={{ width: origem.share }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-3 border-t border-line-subtle text-micro">
                  <div>
                    <span className="text-fg-subtle block uppercase text-[10px] font-semibold">Leads:</span>
                    <span className="num font-bold text-fg text-body">{origem.leads}</span>
                  </div>
                  <div>
                    <span className="text-fg-subtle block uppercase text-[10px] font-semibold">Conversão:</span>
                    <span className="num font-bold text-emerald-400 text-body">{origem.conversao}</span>
                  </div>
                  <div>
                    <span className="text-fg-subtle block uppercase text-[10px] font-semibold">Recuperado:</span>
                    <span className="num font-bold text-brand-ink text-body truncate block">{origem.recuperado}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 4. Caixa Informativa: Como rastrear Mineração e Campanhas */}
      <div className="rise rise-4 panel p-5 rounded-[var(--r-lg)] border border-line-subtle bg-surface-inset/60 space-y-2.5">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-cyan-400" />
          <h3 className="text-h3 text-fg font-bold">Rastreamento Inteligente de Mineração & Tráfego</h3>
        </div>
        <p className="text-micro text-fg-muted">
          Para que as oportunidades da <strong>Mineração</strong> ou <strong>Anúncios</strong> sejam identificadas automaticamente pelo bot AutonomIA e pelo SAC Hermes, inclua parâmetros UTM ou envie no payload do webhook:
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-micro font-mono pt-1">
          <div className="p-2.5 rounded-[var(--r-md)] bg-surface-panel border border-line-subtle">
            <span className="text-cyan-400 font-bold block mb-0.5">⛏️ Mineração / Base Fria:</span>
            <code className="text-fg-subtle select-all">utm_source=mineracao&utm_medium=whatsapp_outreach</code>
          </div>
          <div className="p-2.5 rounded-[var(--r-md)] bg-surface-panel border border-line-subtle">
            <span className="text-blue-400 font-bold block mb-0.5">📱 Anúncios Meta Ads:</span>
            <code className="text-fg-subtle select-all">utm_source=meta_ads&utm_campaign=recuperacao</code>
          </div>
        </div>
      </div>
    </div>
  )
}
