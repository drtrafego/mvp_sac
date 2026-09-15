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
  CheckCircle2,
  Mail,
} from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string; period?: string }>
}

function formatBRL(cents: number): string {
  if (!cents || isNaN(cents)) return 'R$ 0,00'
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function InstagramIcon({ size = 14, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5"/>
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>
    </svg>
  )
}

interface SourceMeta {
  name: string
  category: string
  subcategory: string
  color: string
  badgeColor: string
  iconName: 'whatsapp' | 'email' | 'instagram' | 'meta' | 'google' | 'hotmart' | 'kiwify' | 'greenn' | 'zouti' | 'direct'
}

function normalizeSource(rawSource: string | null, rawMedium: string | null = null): SourceMeta {
  const s = (rawSource || '').toLowerCase().trim()
  const m = (rawMedium || '').toLowerCase().trim()
  const combined = `${s} ${m}`

  // 1. Mineração & Outreach com Subcategorias
  if (combined.includes('miner') || combined.includes('mining') || combined.includes('outreach') || combined.includes('fria') || combined.includes('prospeccao') || combined.includes('places')) {
    if (combined.includes('email') || combined.includes('mail') || combined.includes('brevo')) {
      return {
        name: 'Mineração — E-mail Frio (Brevo)',
        category: 'mineracao',
        subcategory: 'email',
        color: 'bg-indigo-500',
        badgeColor: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20',
        iconName: 'email',
      }
    }
    if (combined.includes('ig') || combined.includes('instagram') || combined.includes('direct')) {
      return {
        name: 'Mineração — Instagram Direct',
        category: 'mineracao',
        subcategory: 'instagram',
        color: 'bg-pink-500',
        badgeColor: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
        iconName: 'instagram',
      }
    }
    // Padrão Mineração: WhatsApp Outreach
    return {
      name: 'Mineração — WhatsApp Outreach',
      category: 'mineracao',
      subcategory: 'whatsapp',
      color: 'bg-cyan-500',
      badgeColor: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
      iconName: 'whatsapp',
    }
  }

  // 2. Anúncios Meta Ads (Instagram Ads vs Facebook Ads)
  if (combined.includes('fb') || combined.includes('meta') || combined.includes('facebook') || combined.includes('anuncio') || (combined.includes('ig') && combined.includes('ads'))) {
    if (combined.includes('instagram') || combined.includes('ig') || combined.includes('stories') || combined.includes('reels')) {
      return {
        name: 'Meta Ads — Instagram (Feed & Stories)',
        category: 'meta_ads',
        subcategory: 'instagram_ads',
        color: 'bg-pink-500',
        badgeColor: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
        iconName: 'instagram',
      }
    }
    return {
      name: 'Meta Ads — Facebook & Instagram Ads',
      category: 'meta_ads',
      subcategory: 'meta_geral',
      color: 'bg-blue-500',
      badgeColor: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
      iconName: 'meta',
    }
  }

  // 3. Instagram Direct / Orgânico
  if (combined.includes('instagram') || combined.includes('direct') || combined.includes('ig_direct')) {
    return {
      name: 'Instagram Direct & DMs Orgânicas',
      category: 'instagram',
      subcategory: 'direct',
      color: 'bg-pink-500',
      badgeColor: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
      iconName: 'instagram',
    }
  }

  // 4. Google Ads & YouTube
  if (combined.includes('google') || combined.includes('gads') || combined.includes('youtube') || combined.includes('yt') || combined.includes('search')) {
    return {
      name: 'Google Ads & YouTube Search',
      category: 'google_ads',
      subcategory: 'search',
      color: 'bg-amber-500',
      badgeColor: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
      iconName: 'google',
    }
  }

  // 5. E-mail Marketing / Campanhas
  if (combined.includes('email') || combined.includes('mail') || combined.includes('newsletter') || combined.includes('brevo')) {
    return {
      name: 'E-mail Marketing & Campanhas (Brevo)',
      category: 'email',
      subcategory: 'email',
      color: 'bg-indigo-500',
      badgeColor: 'text-indigo-400 bg-indigo-500/10 border-indigo-500/20',
      iconName: 'email',
    }
  }

  // 6. Checkouts & Plataformas de Pagamento
  if (combined.includes('hotmart')) {
    return {
      name: 'Hotmart Checkout',
      category: 'checkout',
      subcategory: 'hotmart',
      color: 'bg-orange-500',
      badgeColor: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
      iconName: 'hotmart',
    }
  }
  if (combined.includes('kiwify')) {
    return {
      name: 'Kiwify Checkout',
      category: 'checkout',
      subcategory: 'kiwify',
      color: 'bg-emerald-500',
      badgeColor: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
      iconName: 'kiwify',
    }
  }
  if (combined.includes('greenn')) {
    return {
      name: 'Greenn Checkout',
      category: 'checkout',
      subcategory: 'greenn',
      color: 'bg-lime-500',
      badgeColor: 'text-lime-400 bg-lime-500/10 border-lime-500/20',
      iconName: 'greenn',
    }
  }
  if (combined.includes('zouti')) {
    return {
      name: 'Zouti Checkout',
      category: 'checkout',
      subcategory: 'zouti',
      color: 'bg-purple-500',
      badgeColor: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
      iconName: 'zouti',
    }
  }

  if (!rawSource) {
    return {
      name: 'Direto / Orgânico / Link da Bio',
      category: 'organico',
      subcategory: 'direto',
      color: 'bg-teal-500',
      badgeColor: 'text-teal-400 bg-teal-500/10 border-teal-500/20',
      iconName: 'direct',
    }
  }

  return {
    name: rawSource,
    category: 'other',
    subcategory: 'outros',
    color: 'bg-zinc-500',
    badgeColor: 'text-zinc-400 bg-zinc-500/10 border-zinc-500/20',
    iconName: 'direct',
  }
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
        rawMedium: sql<string>`coalesce(nullif(${recoveryLeads.utmMedium}, ''), '')`,
        total: sql<number>`cast(count(*) as int)`,
        recovered: sql<number>`cast(count(*) filter (where ${recoveryLeads.status} = 'converted') as int)`,
        recoveredValueCents: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.status} = 'converted'), 0) as bigint)`,
      })
      .from(recoveryLeads)
      .where(baseWhere)
      .groupBy(
        sql`coalesce(nullif(${recoveryLeads.trackingSource}, ''), nullif(${recoveryLeads.platform}, ''), 'Direto / Orgânico')`,
        sql`coalesce(nullif(${recoveryLeads.utmMedium}, ''), '')`
      )
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
    subcategory: string
    color: string
    badgeColor: string
    iconName: string
    leads: number
    recovered: number
    recoveredValueCents: number
  }>()

  // Subcategorias específicas de Mineração
  const mineracaoSubcats = {
    whatsapp: { name: 'WhatsApp Outreach', leads: 0, recovered: 0, recoveredValueCents: 0 },
    email: { name: 'E-mail Frio (Brevo)', leads: 0, recovered: 0, recoveredValueCents: 0 },
    instagram: { name: 'Instagram Direct', leads: 0, recovered: 0, recoveredValueCents: 0 },
  }

  for (const row of rawOrigensRows) {
    const meta = normalizeSource(row.rawSource, row.rawMedium)
    const existing = origensMap.get(meta.name) ?? {
      name: meta.name,
      category: meta.category,
      subcategory: meta.subcategory,
      color: meta.color,
      badgeColor: meta.badgeColor,
      iconName: meta.iconName,
      leads: 0,
      recovered: 0,
      recoveredValueCents: 0,
    }
    existing.leads += row.total
    existing.recovered += row.recovered
    existing.recoveredValueCents += Number(row.recoveredValueCents)
    origensMap.set(meta.name, existing)

    // Agrupa subcategorias de Mineração
    if (meta.category === 'mineracao') {
      if (meta.subcategory === 'email') {
        mineracaoSubcats.email.leads += row.total
        mineracaoSubcats.email.recovered += row.recovered
        mineracaoSubcats.email.recoveredValueCents += Number(row.recoveredValueCents)
      } else if (meta.subcategory === 'instagram') {
        mineracaoSubcats.instagram.leads += row.total
        mineracaoSubcats.instagram.recovered += row.recovered
        mineracaoSubcats.instagram.recoveredValueCents += Number(row.recoveredValueCents)
      } else {
        mineracaoSubcats.whatsapp.leads += row.total
        mineracaoSubcats.whatsapp.recovered += row.recovered
        mineracaoSubcats.whatsapp.recoveredValueCents += Number(row.recoveredValueCents)
      }
    }
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
            <h1 className="text-h1 text-fg">Origens de Tráfego, Mineração & Checkouts</h1>
            <p className="text-body text-fg-muted mt-0.5">
              Rastreamento detalhado por canal e subcategoria (<strong>Mineração WhatsApp / E-mail / Instagram</strong>, <strong>Meta Ads</strong>, <strong>Google</strong> e <strong>Checkouts</strong>).
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

      {/* 3. Destaque Especial: Subcategorias de Mineração (WhatsApp, E-mail, Instagram) */}
      <div className="rise rise-3 panel p-5 rounded-[var(--r-lg)] border border-line-subtle bg-surface-panel space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle pb-3">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-[var(--r-md)] bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
              <Target size={15} />
            </div>
            <div>
              <h2 className="text-h3 text-fg font-bold">⛏️ Mineração: Subcategorias de Abordagem</h2>
              <p className="text-micro text-fg-subtle">Desempenho comparativo entre canais de contato frio da prospecção</p>
            </div>
          </div>
          <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            Outreach Multicanal
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Subcat 1: WhatsApp */}
          <div className="p-4 rounded-[var(--r-md)] bg-surface-inset border border-line-subtle flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  <MessageSquare size={14} />
                </div>
                <div>
                  <span className="text-body font-bold text-fg block">WhatsApp</span>
                  <span className="text-[10px] text-fg-subtle">Abordagem Direta</span>
                </div>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                {mineracaoSubcats.whatsapp.leads > 0 && totalLeads > 0
                  ? `${((mineracaoSubcats.whatsapp.leads / totalLeads) * 100).toFixed(1)}%`
                  : '0%'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-line-subtle text-micro">
              <div>
                <span className="text-fg-subtle text-[10px] block font-medium">Leads:</span>
                <span className="font-bold text-fg">{mineracaoSubcats.whatsapp.leads}</span>
              </div>
              <div>
                <span className="text-fg-subtle text-[10px] block font-medium">Conv:</span>
                <span className="font-bold text-emerald-400">
                  {mineracaoSubcats.whatsapp.leads > 0
                    ? `${((mineracaoSubcats.whatsapp.recovered / mineracaoSubcats.whatsapp.leads) * 100).toFixed(1)}%`
                    : '0.0%'}
                </span>
              </div>
              <div>
                <span className="text-fg-subtle text-[10px] block font-medium">Receita:</span>
                <span className="font-bold text-brand-ink truncate block">{formatBRL(mineracaoSubcats.whatsapp.recoveredValueCents)}</span>
              </div>
            </div>
          </div>

          {/* Subcat 2: E-mail (Brevo) */}
          <div className="p-4 rounded-[var(--r-md)] bg-surface-inset border border-line-subtle flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  <Mail size={14} />
                </div>
                <div>
                  <span className="text-body font-bold text-fg block">E-mail (Brevo)</span>
                  <span className="text-[10px] text-fg-subtle">Cold Mail & Follow-up</span>
                </div>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                {mineracaoSubcats.email.leads > 0 && totalLeads > 0
                  ? `${((mineracaoSubcats.email.leads / totalLeads) * 100).toFixed(1)}%`
                  : '0%'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-line-subtle text-micro">
              <div>
                <span className="text-fg-subtle text-[10px] block font-medium">Leads:</span>
                <span className="font-bold text-fg">{mineracaoSubcats.email.leads}</span>
              </div>
              <div>
                <span className="text-fg-subtle text-[10px] block font-medium">Conv:</span>
                <span className="font-bold text-emerald-400">
                  {mineracaoSubcats.email.leads > 0
                    ? `${((mineracaoSubcats.email.recovered / mineracaoSubcats.email.leads) * 100).toFixed(1)}%`
                    : '0.0%'}
                </span>
              </div>
              <div>
                <span className="text-fg-subtle text-[10px] block font-medium">Receita:</span>
                <span className="font-bold text-brand-ink truncate block">{formatBRL(mineracaoSubcats.email.recoveredValueCents)}</span>
              </div>
            </div>
          </div>

          {/* Subcat 3: Instagram Direct */}
          <div className="p-4 rounded-[var(--r-md)] bg-surface-inset border border-line-subtle flex flex-col justify-between space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-lg bg-pink-500/10 text-pink-400 border border-pink-500/20">
                  <InstagramIcon size={14} />
                </div>
                <div>
                  <span className="text-body font-bold text-fg block">Instagram</span>
                  <span className="text-[10px] text-fg-subtle">DMs & Prospecção</span>
                </div>
              </div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-pink-500/10 text-pink-400 border border-pink-500/20">
                {mineracaoSubcats.instagram.leads > 0 && totalLeads > 0
                  ? `${((mineracaoSubcats.instagram.leads / totalLeads) * 100).toFixed(1)}%`
                  : '0%'}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-line-subtle text-micro">
              <div>
                <span className="text-fg-subtle text-[10px] block font-medium">Leads:</span>
                <span className="font-bold text-fg">{mineracaoSubcats.instagram.leads}</span>
              </div>
              <div>
                <span className="text-fg-subtle text-[10px] block font-medium">Conv:</span>
                <span className="font-bold text-emerald-400">
                  {mineracaoSubcats.instagram.leads > 0
                    ? `${((mineracaoSubcats.instagram.recovered / mineracaoSubcats.instagram.leads) * 100).toFixed(1)}%`
                    : '0.0%'}
                </span>
              </div>
              <div>
                <span className="text-fg-subtle text-[10px] block font-medium">Receita:</span>
                <span className="font-bold text-brand-ink truncate block">{formatBRL(mineracaoSubcats.instagram.recoveredValueCents)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Grade de Origens e Canais */}
      <div className="rise rise-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-h2 text-fg">Distribuição por Canal de Origem</h2>
          <span className="num text-micro text-fg-subtle">{origensList.length} origens registradas</span>
        </div>

        {origensList.length === 0 ? (
          <div className="rounded-[var(--r-lg)] border border-dashed border-line-default bg-surface-panel p-10 text-center space-y-2">
            <div className="h-10 w-10 mx-auto rounded-full bg-surface-inset flex items-center justify-center text-fg-faint">
              <Target size={20} />
            </div>
            <p className="text-body font-medium text-fg">Nenhum dado de tráfego no período selecionado</p>
            <p className="text-micro text-fg-subtle max-w-md mx-auto">
              Assim que novos contatos de <strong>Mineração</strong> (WhatsApp, E-mail ou Instagram), <strong>Meta Ads</strong> ou <strong>Webhooks de Plataformas</strong> forem recebidos, aparecerão aqui automaticamente com cores exclusivas.
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
                      {origem.category === 'mineracao'
                        ? '⛏️ Mineração'
                        : origem.category === 'meta_ads'
                        ? '📱 Meta Ads'
                        : origem.category === 'instagram'
                        ? '📸 Instagram'
                        : origem.category === 'email'
                        ? '✉️ E-mail'
                        : origem.category === 'google_ads'
                        ? '🔍 Google'
                        : origem.category === 'checkout'
                        ? '🛒 Checkout'
                        : '🌐 Orgânico'}
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

      {/* 5. Caixa Informativa: Como rastrear Mineração e Campanhas com Subcategorias */}
      <div className="rise rise-5 panel p-5 rounded-[var(--r-lg)] border border-line-subtle bg-surface-inset/60 space-y-3">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-cyan-400" />
          <h3 className="text-h3 text-fg font-bold">Como Configurar UTMs para Rastrear Subcategorias</h3>
        </div>
        <p className="text-micro text-fg-muted">
          Para que o SAC Hermes e o bot AutonomIA identifiquem a origem e a subcategoria de abordagem automaticamente, inclua os parâmetros UTM nas suas URLs de destino ou nos payloads de importação/webhook:
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5 text-micro font-mono pt-1">
          <div className="p-3 rounded-[var(--r-md)] bg-surface-panel border border-line-subtle">
            <span className="text-cyan-400 font-bold block mb-1">💬 Mineração WhatsApp:</span>
            <code className="text-fg-subtle select-all text-[11px] block">utm_source=mineracao&utm_medium=whatsapp</code>
          </div>
          <div className="p-3 rounded-[var(--r-md)] bg-surface-panel border border-line-subtle">
            <span className="text-indigo-400 font-bold block mb-1">✉️ Mineração E-mail (Brevo):</span>
            <code className="text-fg-subtle select-all text-[11px] block">utm_source=mineracao&utm_medium=email</code>
          </div>
          <div className="p-3 rounded-[var(--r-md)] bg-surface-panel border border-line-subtle">
            <span className="text-pink-400 font-bold block mb-1">📸 Mineração Instagram DM:</span>
            <code className="text-fg-subtle select-all text-[11px] block">utm_source=mineracao&utm_medium=instagram</code>
          </div>
          <div className="p-3 rounded-[var(--r-md)] bg-surface-panel border border-line-subtle">
            <span className="text-blue-400 font-bold block mb-1">📱 Meta Ads (Facebook/Instagram):</span>
            <code className="text-fg-subtle select-all text-[11px] block">utm_source=meta_ads&utm_medium=instagram_feed</code>
          </div>
          <div className="p-3 rounded-[var(--r-md)] bg-surface-panel border border-line-subtle">
            <span className="text-amber-400 font-bold block mb-1">🔍 Google Ads & Search:</span>
            <code className="text-fg-subtle select-all text-[11px] block">utm_source=google_ads&utm_medium=search</code>
          </div>
          <div className="p-3 rounded-[var(--r-md)] bg-surface-panel border border-line-subtle">
            <span className="text-orange-400 font-bold block mb-1">🛒 Checkouts & Plataformas:</span>
            <code className="text-fg-subtle select-all text-[11px] block">utm_source=hotmart (ou kiwify/greenn/zouti)</code>
          </div>
        </div>
      </div>
    </div>
  )
}
