export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, and, gte, lte, sql, desc, count } from 'drizzle-orm'
import { resolvePeriod } from '@/lib/period'
import PeriodBar from '@/components/shared/PeriodBar'
import { Suspense } from 'react'
import { Globe, TrendingUp, Layers, ArrowUpRight, DollarSign, Users, ShoppingCart, Target } from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string; period?: string }>
}

function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

const ORIGIN_COLORS = [
  'bg-blue-500',
  'bg-amber-400',
  'bg-purple-400',
  'bg-emerald-400',
  'bg-pink-400',
  'bg-cyan-400',
  'bg-indigo-400',
]

export default async function OrigensPage({ searchParams }: PageProps) {
  const [company, params] = await Promise.all([requireCompany(), searchParams])
  const cid = company.id

  const { from, to } = resolvePeriod(params)
  const fromDate = new Date(`${from}T00:00:00-03:00`)
  const toDate = new Date(`${to}T23:59:59.999-03:00`)

  const dateFilter = and(gte(recoveryLeads.createdAt, fromDate), lte(recoveryLeads.createdAt, toDate))
  const baseWhere = and(eq(recoveryLeads.companyId, cid), dateFilter)

  const [totalRow, origensRows] = await Promise.all([
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
        source: sql<string>`coalesce(nullif(${recoveryLeads.trackingSource}, ''), nullif(${recoveryLeads.platform}, ''), 'Direto / Orgânico')`,
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

  const origens = origensRows.map((row, idx) => {
    const leads = row.total
    const share = totalLeads > 0 ? ((leads / totalLeads) * 100).toFixed(1) : '0.0'
    const conversao = leads > 0 ? ((row.recovered / leads) * 100).toFixed(1) : '0.0'
    const cor = ORIGIN_COLORS[idx % ORIGIN_COLORS.length]

    return {
      nome: row.source,
      slug: row.source.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      share: `${share}%`,
      shareNum: Number(share),
      leads,
      recuperado: formatBRL(Number(row.recoveredValueCents)),
      conversao: `${conversao}%`,
      cor,
    }
  })

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      {/* 1. Cabeçalho com Empresa & PeriodBar */}
      <div className="rise rise-1 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
                <Globe size={12} />
                Empresa: {company.name}
              </span>
            </div>
            <h1 className="text-h1 text-fg">Origens e Aquisição</h1>
            <p className="text-body text-fg-muted mt-0.5">
              De onde vêm os contatos atendidos e qual canal gera maior retorno de receita recuperada.
            </p>
          </div>
          <Suspense fallback={null}>
            <PeriodBar from={from} to={to} />
          </Suspense>
        </div>
      </div>

      {/* 2. KPIs de Origem */}
      <div className="rise rise-2 grid grid-cols-1 sm:grid-cols-3 gap-[var(--space-gutter)]">
        <div className="card p-5 bg-surface-raised border border-line-subtle rounded-2xl">
          <div className="flex items-center justify-between">
            <span className="text-label uppercase text-fg-subtle">Total de Leads</span>
            <Users size={16} className="text-fg-faint" />
          </div>
          <p className="num text-metric text-fg mt-3">{totalLeads}</p>
          <p className="text-micro text-fg-faint mt-1">no período selecionado</p>
        </div>

        <div className="card p-5 bg-surface-raised border border-line-subtle rounded-2xl">
          <div className="flex items-center justify-between">
            <span className="text-label uppercase text-fg-subtle">Taxa Global de Conversão</span>
            <TrendingUp size={16} className="text-emerald-400" />
          </div>
          <p className="num text-metric text-emerald-400 mt-3">{globalConvRate}%</p>
          <p className="text-micro text-fg-faint mt-1">{totalRecovered} vendas recuperadas</p>
        </div>

        <div className="card-highlight p-5 border border-line-subtle rounded-2xl">
          <div className="flex items-center justify-between">
            <span className="text-label uppercase text-fg-subtle">Receita Recuperada</span>
            <DollarSign size={16} className="text-brand-ink" />
          </div>
          <p className="num text-metric text-brand-ink mt-3">{formatBRL(totalRecoveredCents)}</p>
          <p className="text-micro text-fg-faint mt-1">atribuída aos canais de tráfego</p>
        </div>
      </div>

      {/* 3. Grid de Origens */}
      <div className="rise rise-3">
        {origens.length === 0 ? (
          <div className="card bg-surface-raised border border-line-subtle p-12 text-center rounded-2xl">
            <Target size={32} className="mx-auto text-fg-faint mb-3" />
            <h3 className="text-h3 text-fg font-bold">Nenhum dado de tráfego no período</h3>
            <p className="text-body text-fg-muted mt-1 max-w-md mx-auto">
              Quando os webhooks de vendas ou checkouts forem recebidos com parâmetros UTM ou identificadores de plataforma, as origens aparecerão aqui automaticamente.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-[var(--space-gutter)]">
            {origens.map((origem) => (
              <div key={origem.nome} className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl flex flex-col justify-between space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-micro font-mono uppercase text-fg-subtle truncate max-w-[200px]">{origem.slug}</span>
                    <span className="num text-metric-sm font-bold text-fg">{origem.share}</span>
                  </div>
                  <h3 className="text-h3 text-fg font-bold mt-2 truncate" title={origem.nome}>{origem.nome}</h3>
                  <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden mt-3">
                    <div className={`h-full ${origem.cor} rounded-full`} style={{ width: origem.share }} />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 pt-3 border-t border-line-subtle text-micro">
                  <div>
                    <span className="text-fg-faint block uppercase text-[10px]">Leads:</span>
                    <span className="num font-bold text-fg">{origem.leads}</span>
                  </div>
                  <div>
                    <span className="text-fg-faint block uppercase text-[10px]">Conversão:</span>
                    <span className="num font-bold text-brand-ink">{origem.conversao}</span>
                  </div>
                  <div>
                    <span className="text-fg-faint block uppercase text-[10px]">Recuperado:</span>
                    <span className="num font-bold text-emerald-400 truncate block">{origem.recuperado}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
