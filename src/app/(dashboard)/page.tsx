export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { db } from '@/lib/db'
import { recoveryLeads, messageJobs } from '@/lib/db/schema'
import { eq, count, and, desc, sql, gte, lte } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import {
  Users,
  MessageSquare,
  TrendingUp,
  CheckCircle2,
  Receipt,
  QrCode,
  ShoppingCart,
  CreditCard,
  PartyPopper,
  DollarSign,
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  Sparkles,
  Mail,
  Columns3,
  Clock,
  ThumbsUp,
  Activity,
  Globe,
  Radio,
  ExternalLink,
  Building2,
} from 'lucide-react'
import { Suspense } from 'react'
import { MobileRowCard } from '@/components/ui/mobile-row-card'
import { KanbanBoard, KanbanLead } from '@/components/pipeline/kanban-board'
import PeriodBar from '@/components/shared/PeriodBar'
import { resolvePeriod } from '@/lib/period'

const eventTypeLabels: Record<string, string> = {
  boleto: 'Boleto',
  pix: 'Pix',
  carrinho_abandonado: 'Carrinho',
  cartao_recusado: 'Cartão Recusado',
  compra_aprovada: 'Compra Aprovada',
}

const eventTypeVars: Record<string, string> = {
  boleto: '--ev-boleto',
  pix: '--ev-pix',
  carrinho_abandonado: '--ev-carrinho',
  cartao_recusado: '--ev-cartao',
  compra_aprovada: '--ev-aprovada',
}

function getStatusLabel(status: string | null, eventType: string, convertedFrom: string | null): string {
  const isRecovery = ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado'].includes(eventType)
  if (status === 'converted') {
    if (!convertedFrom || convertedFrom === 'webhook') return 'Pagou sozinho'
    return `Recuperado msg ${convertedFrom.replace('msg_', '')}`
  }
  if (status === 'completed') return isRecovery ? 'Sem conversão' : 'Confirmada'
  if (status === 'in_progress') return 'Em recuperação'
  if (status === 'failed') return 'Falhou'
  return 'Aguardando'
}

function getStatusVar(status: string | null, convertedFrom: string | null): string {
  if (status === 'converted') {
    return (!convertedFrom || convertedFrom === 'webhook') ? '--st-info' : '--st-positivo'
  }
  if (status === 'completed') return '--fg-faint'
  if (status === 'in_progress') return '--st-info'
  if (status === 'failed') return '--st-negativo'
  return '--st-atencao'
}

function splitMoney(cents: number): { inteiro: string; centavos: string } {
  const [inteiro, centavos] = (cents / 100)
    .toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .split(',')
  return { inteiro, centavos: centavos ?? '00' }
}

function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function tint(cssVar: string, pct: number): string {
  return `color-mix(in oklch, var(${cssVar}) ${pct}%, transparent)`
}

interface PageProps {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const [company, params] = await Promise.all([requireCompany(), searchParams])
  const cid = company.id

  const { from, to } = resolvePeriod(params)
  const fromDate = new Date(`${from}T00:00:00-03:00`)
  const toDate = new Date(`${to}T23:59:59.999-03:00`)

  const dateFilter = and(gte(recoveryLeads.createdAt, fromDate), lte(recoveryLeads.createdAt, toDate))
  const baseWhere = and(eq(recoveryLeads.companyId, cid), dateFilter)

  const rangeDurationMs = toDate.getTime() - fromDate.getTime()
  const prevFrom = new Date(fromDate.getTime() - rangeDurationMs)

  const [[leadStats], [jobStats], recentLeads, conversionByMsg, [prevStats], trafficBreakdown] = await Promise.all([
    db
      .select({
        total: count(),
        recoveredCount: sql<number>`cast(count(*) filter (where ${recoveryLeads.status} = 'converted' and ${recoveryLeads.convertedFrom} like 'msg_%' and ${recoveryLeads.eventType} in ('boleto','pix','carrinho_abandonado','cartao_recusado')) as int)`,
        recoveredValueCents: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.status} = 'converted' and ${recoveryLeads.convertedFrom} like 'msg_%' and ${recoveryLeads.eventType} in ('boleto','pix','carrinho_abandonado','cartao_recusado')), 0) as bigint)`,
        boleto: sql<number>`cast(count(*) filter (where ${recoveryLeads.eventType} = 'boleto') as int)`,
        pix: sql<number>`cast(count(*) filter (where ${recoveryLeads.eventType} = 'pix') as int)`,
        carrinho: sql<number>`cast(count(*) filter (where ${recoveryLeads.eventType} = 'carrinho_abandonado') as int)`,
        cartao: sql<number>`cast(count(*) filter (where ${recoveryLeads.eventType} = 'cartao_recusado') as int)`,
        aprovada: sql<number>`cast(count(*) filter (where ${recoveryLeads.eventType} = 'compra_aprovada') as int)`,
      })
      .from(recoveryLeads)
      .where(baseWhere),

    db
      .select({
        pending: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'pending') as int)`,
        sent: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'sent') as int)`,
        failed: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'failed') as int)`,
        cancelled: sql<number>`cast(count(*) filter (where ${messageJobs.status} = 'cancelled') as int)`,
      })
      .from(messageJobs)
      .innerJoin(recoveryLeads, eq(messageJobs.leadId, recoveryLeads.id))
      .where(baseWhere),

    db
      .select()
      .from(recoveryLeads)
      .where(baseWhere)
      .orderBy(desc(recoveryLeads.createdAt))
      .limit(20),

    db
      .select({
        convertedFrom: recoveryLeads.convertedFrom,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(recoveryLeads)
      .where(and(baseWhere, eq(recoveryLeads.status, 'converted'), sql`${recoveryLeads.convertedFrom} is not null and ${recoveryLeads.convertedFrom} like 'msg_%'`))
      .groupBy(recoveryLeads.convertedFrom)
      .orderBy(desc(sql`count(*)`)),

    prevFrom && fromDate
      ? db
          .select({
            recoveredValueCents: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.status} = 'converted' and ${recoveryLeads.convertedFrom} like 'msg_%' and ${recoveryLeads.eventType} in ('boleto','pix','carrinho_abandonado','cartao_recusado')), 0) as bigint)`,
          })
          .from(recoveryLeads)
          .where(
            and(
              eq(recoveryLeads.companyId, cid),
              gte(recoveryLeads.createdAt, prevFrom),
              lte(recoveryLeads.createdAt, fromDate),
            ),
          )
      : Promise.resolve([{ recoveredValueCents: 0 }]),

    db
      .select({
        source: sql<string>`coalesce(nullif(${recoveryLeads.trackingSource}, ''), nullif(${recoveryLeads.platform}, ''), 'Direto / Orgânico')`,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(recoveryLeads)
      .where(baseWhere)
      .groupBy(sql`coalesce(nullif(${recoveryLeads.trackingSource}, ''), nullif(${recoveryLeads.platform}, ''), 'Direto / Orgânico')`)
      .orderBy(desc(sql<number>`count(*)`))
      .limit(5),
  ])

  const total = leadStats?.total ?? 0
  const recoveredCount = leadStats?.recoveredCount ?? 0
  const recoveryTotal = (leadStats?.boleto ?? 0) + (leadStats?.pix ?? 0) + (leadStats?.carrinho ?? 0) + (leadStats?.cartao ?? 0)
  const conversionRate = recoveryTotal > 0 ? ((recoveredCount / recoveryTotal) * 100).toFixed(1) : '0.0'

  const kanbanLeads: KanbanLead[] = recentLeads.map((l) => {
    let stage = 'novo_contato'
    if (l.status === 'converted' || l.eventType === 'compra_aprovada') {
      stage = 'fechado'
    } else if (l.status === 'in_progress') {
      stage = 'em_atendimento'
    } else if (l.eventType === 'pix' || l.eventType === 'boleto') {
      stage = 'qualificado'
    } else if (l.priority && l.priority > 1) {
      stage = 'agendado'
    }

    return {
      id: l.id,
      name: l.name,
      phone: l.phone,
      email: l.email,
      productName: l.productName,
      productValue: l.productValue,
      eventType: l.eventType,
      platform: l.platform,
      status: l.status,
      stage,
      agentName: 'AutonomIA',
      channel: ((l.rawPayload as any)?.channel as any) || 'whatsapp',
      updatedAt: l.updatedAt,
    }
  })

  const recoveredCents = Number(leadStats?.recoveredValueCents ?? 0)
  const prevCents = Number(prevStats?.recoveredValueCents ?? 0)
  const money = splitMoney(recoveredCents)

  const deltaPct = prevFrom && prevCents > 0
    ? ((recoveredCents - prevCents) / prevCents) * 100
    : null
  const deltaUp = deltaPct !== null && deltaPct >= 0

  const queue = [
    { label: 'Pendentes', value: jobStats?.pending ?? 0, cssVar: '--st-atencao' },
    { label: 'Enviadas', value: jobStats?.sent ?? 0, cssVar: '--st-positivo' },
    { label: 'Falhas', value: jobStats?.failed ?? 0, cssVar: '--st-negativo' },
    { label: 'Canceladas', value: jobStats?.cancelled ?? 0, cssVar: '--fg-faint' },
  ]
  const queueTotal = queue.reduce((acc, item) => acc + item.value, 0)

  // Cards de recuperação com link direto para as rotas dedicadas
  const eventCards = [
    { label: 'Boleto', href: '/boleto', value: leadStats?.boleto ?? 0, icon: Receipt, cssVar: eventTypeVars.boleto },
    { label: 'Pix', href: '/pix', value: leadStats?.pix ?? 0, icon: QrCode, cssVar: eventTypeVars.pix },
    { label: 'Carrinho', href: '/carrinho', value: leadStats?.carrinho ?? 0, icon: ShoppingCart, cssVar: eventTypeVars.carrinho_abandonado },
    { label: 'Cartão Recusado', href: '/cartao-recusado', value: leadStats?.cartao ?? 0, icon: CreditCard, cssVar: eventTypeVars.cartao_recusado },
    { label: 'Compra Aprovada', href: '/compra-aprovada', value: leadStats?.aprovada ?? 0, icon: PartyPopper, cssVar: eventTypeVars.compra_aprovada },
  ]

  const kpis = [
    { label: 'Leads', value: String(total), icon: Users, hint: 'no período' },
    { label: 'Recuperados', value: String(recoveredCount), icon: CheckCircle2, hint: 'pelo sistema' },
    { label: 'Conversão', value: `${conversionRate}%`, icon: TrendingUp, hint: 'de leads recuperados' },
    { label: 'Mensagens', value: String(jobStats?.sent ?? 0), icon: MessageSquare, hint: 'WhatsApp enviadas' },
  ]

  const sentJobs = jobStats?.sent ?? 0
  const failedJobs = jobStats?.failed ?? 0
  const pendingJobs = jobStats?.pending ?? 0
  const deliveryRate = sentJobs + failedJobs > 0 ? (((sentJobs) / (sentJobs + failedJobs)) * 100).toFixed(1) : '100.0'

  // Indicadores de Eficiência Operacional reais do SAC
  const operationalSLA = [
    { label: 'Taxa de Entrega', value: `${deliveryRate}%`, icon: CheckCircle2, note: `${sentJobs} entregues com sucesso`, tag: 'WhatsApp' },
    { label: 'Fila de Mensagens', value: `${pendingJobs}`, icon: Clock, note: 'Mensagens agendadas / fila', tag: 'Outbox' },
    { label: 'Taxa de Conversão', value: `${conversionRate}%`, icon: TrendingUp, note: `${recoveredCount} de ${recoveryTotal} recuperados`, tag: 'Vendas' },
    { label: 'Total de Leads', value: `${total}`, icon: Users, note: 'Checkouts, Anúncios & Mineração', tag: 'Captação' },
  ]

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      {/* 1. Cabeçalho da Empresa Ativa & Filtro de Datas da Home */}
      <div className="rise rise-1 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
                <Building2 size={12} />
                Empresa: {company.name}
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                SaaS Ativo · /{company.slug}
              </span>
            </div>
            <h1 className="text-h1 text-fg">Central de Atendimento & Vendas</h1>
            <p className="text-body text-fg-muted mt-0.5">
              Visão geral multicanal integrada com Hotmart, Kiwify, Greenn, Zouti e Mineração.
            </p>
          </div>
          <Suspense fallback={null}>
            <PeriodBar from={from} to={to} />
          </Suspense>
        </div>

        {/* Canais e Plataformas Conectadas */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line-subtle text-micro text-fg-subtle">
          <Link href="/canais" className="font-semibold text-fg hover:text-brand-ink transition-colors flex items-center gap-1">
            Canais:
          </Link>
          <span className="inline-flex items-center gap-1 bg-surface-raised border border-line-subtle px-2 py-0.5 rounded text-fg-muted">
            <MessageSquare size={12} className="text-emerald-400" /> WhatsApp
          </span>
          <span className="inline-flex items-center gap-1 bg-surface-raised border border-line-subtle px-2 py-0.5 rounded text-fg-muted">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-pink-400">
              <rect width="20" height="20" x="2" y="2" rx="5" ry="5"/>
              <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
              <line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>
            </svg>
            Instagram DM
          </span>
          <span className="inline-flex items-center gap-1 bg-surface-raised border border-line-subtle px-2 py-0.5 rounded text-fg-muted">
            <Mail size={12} className="text-indigo-400" /> E-mail (Brevo)
          </span>

          <span className="mx-1 text-fg-faint">•</span>

          <Link href="/origens" className="font-semibold text-fg hover:text-brand-ink transition-colors">
            Origens & Checkouts:
          </Link>
          {/* Mineração com subcategorias */}
          <Link href="/origens" className="inline-flex items-center gap-1.5 text-[10px] font-bold text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 px-2 py-0.5 rounded hover:bg-cyan-500/20 transition-all">
            <span>⛏️ Mineração</span>
            <span className="text-[9px] font-normal text-cyan-300/80">(WhatsApp • E-mail • Insta)</span>
          </Link>
          <Link href="/origens" className="text-[10px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded hover:bg-blue-500/20 transition-all">
            Meta Ads
          </Link>
          <Link href="/origens" className="text-[10px] font-bold text-pink-400 bg-pink-500/10 border border-pink-500/20 px-2 py-0.5 rounded hover:bg-pink-500/20 transition-all">
            Instagram
          </Link>
          <Link href="/origens" className="text-[10px] font-bold text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-0.5 rounded hover:bg-orange-500/20 transition-all">
            Hotmart
          </Link>
          <Link href="/origens" className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded hover:bg-emerald-500/20 transition-all">
            Kiwify
          </Link>
          <Link href="/origens" className="text-[10px] font-bold text-lime-400 bg-lime-500/10 border border-lime-500/20 px-2 py-0.5 rounded hover:bg-lime-500/20 transition-all">
            Greenn
          </Link>
          <Link href="/origens" className="text-[10px] font-bold text-purple-400 bg-purple-500/10 border border-purple-500/20 px-2 py-0.5 rounded hover:bg-purple-500/20 transition-all">
            Zouti
          </Link>
        </div>
      </div>

      {/* 2. Herói de receita mais KPIs principais */}
      <div className="rise rise-2 grid grid-cols-12 gap-[var(--space-gutter)]">
        <div
          className="card-highlight col-span-12 lg:col-span-5 flex flex-col justify-between p-[var(--space-card)]"
          style={{ minHeight: 'clamp(150px, 12vw, 210px)' }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <div
                className="flex h-7 w-7 items-center justify-center rounded-[var(--r-md)] border"
                style={{
                  background: tint('--brand', 14),
                  borderColor: tint('--brand', 24),
                }}
              >
                <DollarSign size={14} style={{ color: 'var(--brand-ink)' }} />
              </div>
              <p className="text-label uppercase text-fg-subtle">Receita Recuperada</p>
            </div>
            <ArrowUpRight size={14} className="text-fg-faint" />
          </div>

          <div className="mt-4">
            <p className="num text-display text-brand-ink">
              <span className="num-affix">R$ </span>
              {money.inteiro}
              <span className="num-affix">,{money.centavos}</span>
            </p>
            {deltaPct !== null ? (
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={`inline-flex items-center gap-1 ${deltaUp ? 'text-st-positivo' : 'text-st-negativo'}`}>
                  {deltaUp ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                  <span className="num text-micro">
                    {Math.abs(deltaPct).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%
                  </span>
                </span>
                <span className="text-micro text-fg-subtle">vs período anterior</span>
              </p>
            ) : (
              <p className="text-micro text-fg-subtle mt-2">vendas recuperadas pelo sistema</p>
            )}
          </div>
        </div>

        {/* As quatro métricas de apoio */}
        <div className="col-span-12 lg:col-span-7 grid grid-cols-2 gap-[var(--space-gutter)] lg:grid-cols-4">
          {kpis.map(({ label, value, icon: Icon, hint }) => (
            <div
              key={label}
              className="card flex flex-col justify-between p-[var(--space-card)]"
              style={{ minHeight: 'clamp(120px, 9vw, 150px)' }}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-label uppercase text-fg-subtle">{label}</p>
                <Icon size={13} className="text-fg-faint shrink-0" />
              </div>
              <div className="mt-3">
                <p className="num text-metric text-fg">{value}</p>
                <p className="text-micro text-fg-faint mt-1">{hint}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 3. Indicadores de Eficiência & SLA Operacional do SAC */}
      <div className="rise rise-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-label uppercase text-fg-subtle flex items-center gap-1.5 font-bold">
            <Activity size={13} className="text-brand-ink" />
            Eficiência & SLA do Atendimento
          </h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-[var(--space-gutter)]">
          {operationalSLA.map(({ label, value, icon: Icon, note, tag }) => (
            <div
              key={label}
              className="card bg-surface-raised p-3.5 flex flex-col justify-between border border-line-subtle rounded-xl"
            >
              <div className="flex items-center justify-between">
                <span className="text-micro uppercase text-fg-subtle font-semibold flex items-center gap-1.5">
                  <Icon size={13} className="text-fg-muted" />
                  {label}
                </span>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {tag}
                </span>
              </div>
              <div className="mt-2">
                <span className="num text-metric-sm font-bold text-fg block">{value}</span>
                <span className="text-[11px] text-fg-faint mt-0.5 block">{note}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 4. Cards de eventos de checkout com links diretos */}
      <div className="rise rise-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-label uppercase text-fg-subtle font-bold">Eventos de Checkout & Recuperação</p>
        </div>
        <div className="scroll-thin flex snap-x snap-mandatory gap-[var(--space-gutter)] overflow-x-auto pb-2 md:grid md:grid-cols-5 md:overflow-visible md:pb-0">
          {eventCards.map(({ label, href, value, icon: Icon, cssVar }) => (
            <Link
              key={label}
              href={href}
              className="card bg-surface-raised min-w-[150px] shrink-0 snap-start p-[var(--space-card)] md:min-w-0 md:shrink hover:border-brand-ink/50 transition-all group"
            >
              <span
                className="block h-[2px] w-8 rounded-full transition-all group-hover:w-12"
                style={{ background: tint(cssVar, 70) }}
              />
              <div
                className="mt-3 flex h-7 w-7 items-center justify-center rounded-[var(--r-md)] border"
                style={{ background: tint(cssVar, 10), borderColor: tint(cssVar, 18) }}
              >
                <Icon size={14} style={{ color: `var(${cssVar})` }} />
              </div>
              <p className="text-label uppercase text-fg-subtle mt-3 group-hover:text-fg transition-colors">{label}</p>
              <p className="num text-metric-sm text-fg mt-1">{value}</p>
            </Link>
          ))}
        </div>
      </div>

      {/* 5. Gráficos de Canais & Origens de Tráfego do SAC */}
      <div className="rise rise-4 grid grid-cols-1 md:grid-cols-2 gap-[var(--space-gutter)]">
        {/* Distribuição por Canal de Atendimento */}
        <div className="card-section p-[var(--space-card)] flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-h3 text-fg flex items-center gap-1.5 font-bold">
                <Radio size={15} className="text-emerald-400" />
                Canais de Atendimento
              </h3>
              <span className="text-micro text-fg-subtle">Volume Real</span>
            </div>
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between text-micro mb-1">
                  <span className="inline-flex items-center gap-1.5 text-fg font-medium">
                    <MessageSquare size={13} className="text-emerald-400" />
                    WhatsApp (Meta Cloud API & Uazapi)
                  </span>
                  <span className="num font-bold text-fg">
                    {total > 0 ? 100 : 0}%{' '}
                    <span className="text-fg-faint font-normal">({total} leads)</span>
                  </span>
                </div>
                <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-400 rounded-full" style={{ width: total > 0 ? '100%' : '0%' }} />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-micro mb-1">
                  <span className="inline-flex items-center gap-1.5 text-fg font-medium">
                    <CheckCircle2 size={13} className="text-blue-400" />
                    Mensagens Enviadas
                  </span>
                  <span className="num font-bold text-fg">
                    <span className="text-fg-faint font-normal">{sentJobs} disparos ({deliveryRate}% entrega)</span>
                  </span>
                </div>
                <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden">
                  <div className="h-full bg-blue-400 rounded-full" style={{ width: `${Math.min(Number(deliveryRate), 100)}%` }} />
                </div>
              </div>
            </div>
          </div>
          <p className="text-[11px] text-fg-subtle mt-4 pt-3 border-t border-line-subtle flex items-center justify-between">
            <span>Taxa de Entrega WhatsApp: <strong className="text-emerald-400">{deliveryRate}%</strong></span>
            <Link href="/canais" className="text-brand-ink hover:underline font-semibold">Ver detalhes</Link>
          </p>
        </div>

        {/* Origens de Tráfego e Aquisição */}
        <div className="card-section p-[var(--space-card)] flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-h3 text-fg flex items-center gap-1.5 font-bold">
                <Globe size={15} className="text-blue-400" />
                Origens de Tráfego
              </h3>
              <span className="text-micro text-fg-subtle">Aquisição de Leads</span>
            </div>

            {trafficBreakdown.length === 0 ? (
              <div className="py-8 text-center text-micro text-fg-subtle">
                Nenhum lead ou webhook registrado no período selecionado.
              </div>
            ) : (
              <div className="space-y-3">
                {trafficBreakdown.map((item, idx) => {
                  const pct = total > 0 ? Math.round((item.count / total) * 100) : 0
                  const colors = ['bg-blue-500', 'bg-amber-400', 'bg-emerald-400', 'bg-purple-400', 'bg-cyan-400']
                  const color = colors[idx % colors.length]
                  return (
                    <div key={item.source}>
                      <div className="flex items-center justify-between text-micro mb-1">
                        <span className="text-fg font-medium truncate max-w-[200px]" title={item.source}>
                          {item.source}
                        </span>
                        <span className="num font-bold text-fg">{pct}% <span className="text-fg-faint font-normal">({item.count})</span></span>
                      </div>
                      <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden">
                        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
          <p className="text-[11px] text-fg-subtle mt-4 pt-3 border-t border-line-subtle flex items-center justify-between">
            <span>Rastreamento Ativo UTM: <strong className="text-brand-ink">100%</strong></span>
            <Link href="/origens" className="text-brand-ink hover:underline font-semibold">Ver detalhes</Link>
          </p>
        </div>
      </div>

      {/* 6. Pipeline de Atendimento (Kanban Casal do Tráfego Interativo com Edição de Modal) */}
      <div className="rise rise-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-h2 text-fg flex items-center gap-2">
              <Columns3 size={18} className="text-brand-ink" />
              Pipeline de Atendimento (Kanban)
            </h2>
            <p className="text-micro text-fg-subtle">
              Arraste os contatos entre as etapas ou clique em qualquer card para editar dados, notas ou abrir WhatsApp.
            </p>
          </div>
          <Link
            href="/pipeline"
            className="text-micro font-semibold text-brand-ink hover:underline flex items-center gap-1"
          >
            Quadro Completo <ExternalLink size={13} />
          </Link>
        </div>
        <KanbanBoard initialLeads={kanbanLeads} />
      </div>

      {/* 7. Fila de mensagens em tempo real */}
      <div className="rise rise-5 card-section p-[var(--space-card)]">
        <div className="flex items-center gap-2">
          <p className="text-label uppercase text-fg-subtle">Fila de Mensagens Automáticas</p>
          {(jobStats?.pending ?? 0) > 0 && (
            <span className="dot live-dot text-brand-ink" aria-hidden />
          )}
        </div>

        <div className="mt-4 flex h-2 overflow-hidden rounded-full bg-surface-inset">
          {queueTotal > 0 &&
            queue.map(({ label, value, cssVar }) =>
              value > 0 ? (
                <span
                  key={label}
                  style={{ width: `${(value / queueTotal) * 100}%`, background: `var(${cssVar})` }}
                />
              ) : null,
            )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
          {queue.map(({ label, value, cssVar }) => (
            <span key={label} className="inline-flex items-center gap-2">
              <span className="dot" style={{ color: `var(${cssVar})` }} />
              <span className="text-micro text-fg-muted">{label}</span>
              <span className="num text-micro text-fg">{value}</span>
            </span>
          ))}
        </div>
      </div>

      {/* 8. Conversão por mensagem da sequência */}
      {conversionByMsg.length > 0 && (
        <div className="rise rise-5 card-section p-[var(--space-card)]">
          <p className="text-label uppercase text-fg-subtle mb-4">
            Conversões por Mensagem da Sequência de Recuperação
          </p>
          <div className="space-y-3">
            {conversionByMsg.map((row) => {
              const label = row.convertedFrom?.replace('msg_', 'Mensagem ') ?? ''
              const pct = recoveredCount > 0 ? Math.round((row.count / recoveredCount) * 100) : 0
              return (
                <div key={row.convertedFrom} className="flex items-center gap-3">
                  <span className="text-micro text-fg-muted w-24 shrink-0">{label}</span>
                  <div className="progress-bar flex-1">
                    <div className="progress-fill" style={{ width: `${pct}%`, background: 'var(--fg-muted)' }} />
                  </div>
                  <span className="num text-micro text-fg-muted w-20 text-right">
                    {row.count} <span className="text-fg-faint">({pct}%)</span>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* 9. Leads recentes com disparo de WhatsApp */}
      <div className="rise rise-6 card-section overflow-hidden">
        <div className="flex items-center justify-between border-b border-line-subtle px-5 py-4">
          <div>
            <h2 className="text-h2 text-fg">Leads Recentes em Atendimento</h2>
            <p className="text-micro text-fg-subtle mt-0.5">{recentLeads.length} registros no período selecionado</p>
          </div>
          <Link
            href="/leads"
            className="text-micro font-semibold text-brand-ink hover:underline flex items-center gap-1"
          >
            Ver todos os leads <ArrowUpRight size={13} />
          </Link>
        </div>

        {/* Celular: cada lead vira um card */}
        <div className="md:hidden p-3 space-y-2">
          {recentLeads.length === 0 && (
            <p className="py-8 text-center text-body text-fg-subtle">Nenhum lead no período selecionado</p>
          )}
          {recentLeads.map((lead) => (
            <MobileRowCard
              key={lead.id}
              title={lead.name ?? '-'}
              subtitle={lead.productName ?? '-'}
              meta={
                <>
                  <span className="num text-fg font-medium">
                    {lead.productValue ? formatBRL(lead.productValue) : '-'}
                  </span>
                  <span className="num text-fg-subtle">{lead.phone}</span>
                  <span className="num text-fg-faint">
                    {lead.createdAt
                      ? new Date(lead.createdAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' })
                      : '-'}
                  </span>
                </>
              }
              badges={
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                    <span className="dot" style={{ color: `var(${eventTypeVars[lead.eventType] ?? '--fg-muted'})` }} />
                    {eventTypeLabels[lead.eventType] ?? lead.eventType}
                  </span>
                  <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                    <span className="dot" style={{ color: `var(${getStatusVar(lead.status, lead.convertedFrom)})` }} />
                    {getStatusLabel(lead.status, lead.eventType, lead.convertedFrom)}
                  </span>
                </div>
              }
            />
          ))}
        </div>

        {/* Desktop: tabela */}
        <div className="hidden md:block overflow-x-auto scroll-thin">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line-subtle">
                <th className="px-5 py-3 text-left text-label uppercase text-fg-subtle whitespace-nowrap">Nome</th>
                <th className="px-5 py-3 text-left text-label uppercase text-fg-subtle whitespace-nowrap">Produto</th>
                <th className="px-5 py-3 text-right text-label uppercase text-fg-subtle whitespace-nowrap">Valor</th>
                <th className="px-5 py-3 text-left text-label uppercase text-fg-subtle whitespace-nowrap">Tipo</th>
                <th className="px-5 py-3 text-left text-label uppercase text-fg-subtle whitespace-nowrap">Status</th>
                <th className="px-5 py-3 text-left text-label uppercase text-fg-subtle whitespace-nowrap">Data</th>
                <th className="w-full" aria-hidden />
              </tr>
            </thead>
            <tbody>
              {recentLeads.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-5 py-14 text-center text-body text-fg-subtle">
                    Nenhum lead no período selecionado
                  </td>
                </tr>
              )}
              {recentLeads.map((lead) => (
                <tr key={lead.id} className="h-12 border-b border-line-subtle tr-hover">
                  <td className="px-5">
                    <div className="max-w-[280px] truncate text-body font-medium text-fg" title={lead.name ?? undefined}>
                      {lead.name ?? '-'}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="num text-micro text-fg-subtle">{lead.phone}</span>
                      {lead.phone && (
                        <a
                          href={`https://wa.me/${lead.phone.replace(/\D/g, '')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Abrir no WhatsApp"
                          className="focus-ring shrink-0 rounded-[var(--r-sm)] text-fg-faint transition-colors duration-150 hover:text-brand-ink"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                          </svg>
                        </a>
                      )}
                    </div>
                  </td>
                  <td className="px-5">
                    <span className="block max-w-[240px] truncate text-micro text-fg-muted" title={lead.productName ?? undefined}>
                      {lead.productName ?? '-'}
                    </span>
                  </td>
                  <td className="num px-5 text-right text-body font-medium text-fg whitespace-nowrap">
                    {lead.productValue
                      ? formatBRL(lead.productValue)
                      : <span className="text-fg-faint">-</span>}
                  </td>
                  <td className="px-5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                      <span className="dot" style={{ color: `var(${eventTypeVars[lead.eventType] ?? '--fg-muted'})` }} />
                      {eventTypeLabels[lead.eventType] ?? lead.eventType}
                    </span>
                  </td>
                  <td className="px-5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1.5 text-micro text-fg-muted">
                      <span className="dot" style={{ color: `var(${getStatusVar(lead.status, lead.convertedFrom)})` }} />
                      {getStatusLabel(lead.status, lead.eventType, lead.convertedFrom)}
                    </span>
                  </td>
                  <td className="num px-5 text-micro text-fg-subtle whitespace-nowrap">
                    {lead.createdAt
                      ? new Date(lead.createdAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
                      : '-'}
                  </td>
                  <td aria-hidden />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
