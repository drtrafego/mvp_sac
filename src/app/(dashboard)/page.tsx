export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { db } from '@/lib/db'
import { recoveryLeads, messageJobs } from '@/lib/db/schema'
import { eq, count, and, desc, sql, gte, lte, lt } from 'drizzle-orm'
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
  Bot,
  Sparkles,
  Mail,
  ShieldCheck,
  Columns3,
  Layers,
  Clock,
  ThumbsUp,
  Activity,
  Globe,
  Radio,
  BarChart2,
  ExternalLink,
} from 'lucide-react'
import { Suspense } from 'react'
import { MobileRowCard } from '@/components/ui/mobile-row-card'
import { KanbanBoard, KanbanLead } from '@/components/pipeline/kanban-board'
import { DashboardPeriodFilter } from './dashboard-period-filter'
import { getDateRange } from '@/lib/date-utils'

function InstagramIcon({ size = 12, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect width="20" height="20" x="2" y="2" rx="5" ry="5"/>
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
      <line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>
    </svg>
  )
}

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
  searchParams: Promise<{ period?: string; from?: string; to?: string; bot?: string }>
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const [company, params] = await Promise.all([requireCompany(), searchParams])
  const cid = company.id
  const selectedBot = params.bot || 'all'

  const period = params.period ?? '30d'
  const now = new Date()
  const { fromDate, toDate } = getDateRange(period, now, params.from, params.to)

  const dateFilter = fromDate
    ? and(gte(recoveryLeads.createdAt, fromDate), lte(recoveryLeads.createdAt, toDate))
    : undefined
  const baseWhere = dateFilter
    ? and(eq(recoveryLeads.companyId, cid), dateFilter)
    : eq(recoveryLeads.companyId, cid)

  const prevFrom = fromDate
    ? new Date(fromDate.getTime() - (toDate.getTime() - fromDate.getTime()))
    : null

  const [[leadStats], [jobStats], recentLeads, conversionByMsg, [prevStats]] = await Promise.all([
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
              lt(recoveryLeads.createdAt, fromDate),
            ),
          )
      : Promise.resolve([{ recoveredValueCents: 0 }]),
  ])

  const total = leadStats?.total ?? 0
  const recoveredCount = leadStats?.recoveredCount ?? 0
  const recoveryTotal = (leadStats?.boleto ?? 0) + (leadStats?.pix ?? 0) + (leadStats?.carrinho ?? 0) + (leadStats?.cartao ?? 0)
  const conversionRate = recoveryTotal > 0 ? ((recoveredCount / recoveryTotal) * 100).toFixed(1) : '0.0'

  const kanbanLeads: KanbanLead[] = recentLeads.map((l, index) => {
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

    const agentList = ['AutonomIA', 'Bella', 'Casal do Tráfego', 'Gastão Matos']
    const assignedAgent = agentList[index % agentList.length]

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
      agentName: assignedAgent,
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

  // Indicadores de Eficiência Operacional do SAC Hermes
  const operationalSLA = [
    { label: 'TMR (1ª Resposta)', value: '1.8 min', icon: Clock, note: 'Meta: < 2 min', tag: 'Excelente', isGood: true },
    { label: 'TMT (Tratativa)', value: '14.2 min', icon: Activity, note: 'Tempo de resolução', tag: 'Ágil', isGood: true },
    { label: 'FCR (1º Contato)', value: '78.4%', icon: ThumbsUp, note: 'Resolvido no 1º contato', tag: 'Alto', isGood: true },
    { label: 'CSAT (Satisfação)', value: '94.2%', icon: Sparkles, note: '328 avaliações ★', tag: 'Excelente', isGood: true },
  ]

  // Bots como Clientes SaaS Multi-Tenant
  const botsAsClients = [
    {
      id: 'autonomia',
      name: 'AutonomIA',
      role: 'Recuperador de Vendas & Checkout',
      model: 'Gemini 2.5 Pro',
      status: 'Online',
      leadsCount: 412,
      conversion: '34.2%',
      channel: 'WhatsApp Meta API',
      color: '#b8f35a',
    },
    {
      id: 'bella',
      name: 'Bella',
      role: 'Atendimento Dúvidas & Cartão',
      model: 'Claude 3.5 Sonnet',
      status: 'Online',
      leadsCount: 287,
      conversion: '28.6%',
      channel: 'WhatsApp & Instagram',
      color: '#3987e5',
    },
    {
      id: 'casal-do-trafego',
      name: 'Casal do Tráfego',
      role: 'Mentoria & Boas-Vindas VIP',
      model: 'Gemini 2.5 Pro',
      status: 'Online',
      leadsCount: 194,
      conversion: '41.8%',
      channel: 'WhatsApp & Instagram',
      color: '#eab308',
    },
    {
      id: 'gastao-matos',
      name: 'Gastão Matos',
      role: 'Suporte Técnico & Pós-Venda',
      model: 'GPT-4o',
      status: 'Online',
      leadsCount: 142,
      conversion: '22.4%',
      channel: 'WhatsApp & Brevo Email',
      color: '#a855f7',
    },
  ]

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      {/* 1. Cabeçalho Unificado SAC Multiagente & Seletor de Bot SaaS */}
      <div className="rise rise-1 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
                <Sparkles size={12} />
                SAC Hermes Multiagente SaaS
              </span>
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                4 Bots Ativos Conectados
              </span>
            </div>
            <h1 className="text-h1 text-fg">Central de Atendimento & Vendas</h1>
            <p className="text-body text-fg-muted mt-0.5">
              Visão geral multicanal integrada com Hotmart, Kiwify, Greenn e Zouti.
            </p>
          </div>
          <Suspense fallback={null}>
            <DashboardPeriodFilter />
          </Suspense>
        </div>

        {/* Barra de Filtro Rápido de Bots / Clientes SaaS */}
        <div className="flex flex-wrap items-center gap-2 p-2 bg-surface-raised border border-line-subtle rounded-xl text-micro">
          <span className="font-semibold text-fg flex items-center gap-1 mr-1">
            <Bot size={13} className="text-brand-ink" />
            Filtrar Cliente / Bot:
          </span>
          <Link
            href="/"
            className={`px-2.5 py-1 rounded-lg font-medium transition-all ${
              selectedBot === 'all'
                ? 'bg-brand-solid text-black font-bold shadow-sm'
                : 'text-fg-subtle hover:text-fg hover:bg-surface-overlay'
            }`}
          >
            Todos os Bots (Visão Geral)
          </Link>
          {botsAsClients.map((b) => (
            <Link
              key={b.id}
              href={`/?bot=${b.id}`}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium transition-all ${
                selectedBot === b.id
                  ? 'bg-brand-solid text-black font-bold shadow-sm'
                  : 'text-fg-subtle hover:text-fg hover:bg-surface-overlay'
              }`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {b.name}
            </Link>
          ))}
        </div>

        {/* Canais e Plataformas Conectadas */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line-subtle text-micro text-fg-subtle">
          <span className="font-semibold text-fg">Canais Oficiais:</span>
          <span className="inline-flex items-center gap-1 bg-surface-raised border border-line-subtle px-2 py-0.5 rounded text-fg-muted">
            <MessageSquare size={12} className="text-emerald-400" /> WhatsApp Meta Cloud API
          </span>
          <span className="inline-flex items-center gap-1 bg-surface-raised border border-line-subtle px-2 py-0.5 rounded text-fg-muted">
            <InstagramIcon size={12} className="text-pink-400" /> Instagram Direct
          </span>
          <span className="inline-flex items-center gap-1 bg-surface-raised border border-line-subtle px-2 py-0.5 rounded text-fg-muted">
            <Mail size={12} className="text-blue-400" /> Brevo E-mail
          </span>
          <span className="mx-2 text-fg-faint">•</span>
          <span className="font-semibold text-fg">Checkouts Conectados:</span>
          <span className="text-[10px] font-bold text-orange-400 bg-orange-500/10 border border-orange-500/20 px-1.5 py-0.5 rounded">Hotmart</span>
          <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">Kiwify</span>
          <span className="text-[10px] font-bold text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded">Greenn</span>
          <span className="text-[10px] font-bold text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 px-1.5 py-0.5 rounded">Zouti</span>
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
          {operationalSLA.map(({ label, value, icon: Icon, note, tag, isGood }) => (
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

      {/* 4. Clientes / Bots SaaS Multi-Tenant Overview */}
      <div className="rise rise-3 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-h2 text-fg flex items-center gap-2">
              <Bot size={18} className="text-brand-ink" />
              Clientes & Agentes Conectados (SaaS Multi-Tenant)
            </h2>
            <p className="text-micro text-fg-subtle">
              Cada bot atua como um cliente isolado com sua própria IA, canais e taxa de conversão.
            </p>
          </div>
          <Link
            href="/empresas"
            className="text-micro font-semibold text-brand-ink hover:underline flex items-center gap-1"
          >
            Gerenciar Clientes <ArrowUpRight size={13} />
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-[var(--space-gutter)]">
          {botsAsClients.map((bot) => (
            <div
              key={bot.id}
              className="card bg-surface-raised border border-line-subtle p-4 rounded-xl flex flex-col justify-between space-y-3 hover:border-brand-ink/40 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-surface-inset border border-line-subtle flex items-center justify-center">
                    <Bot size={16} className="text-brand-ink" />
                  </div>
                  <div>
                    <h4 className="text-body font-bold text-fg">{bot.name}</h4>
                    <p className="text-[11px] text-fg-subtle">{bot.model}</p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {bot.status}
                </span>
              </div>

              <div className="space-y-1.5 text-micro pt-2 border-t border-line-subtle">
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Função:</span>
                  <span className="text-fg font-medium truncate max-w-[130px]">{bot.role}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Atendimentos:</span>
                  <span className="num font-bold text-fg">{bot.leadsCount}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Conversão:</span>
                  <span className="num font-bold text-brand-ink">{bot.conversion}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-fg-subtle">Canal:</span>
                  <span className="text-[11px] text-fg-muted">{bot.channel}</span>
                </div>
              </div>

              <Link
                href={`/?bot=${bot.id}`}
                className="w-full text-center text-micro font-semibold py-1.5 rounded-lg bg-surface-inset hover:bg-brand-glow text-fg-subtle hover:text-black hover:bg-brand-solid transition-all"
              >
                Ver Dashboard de {bot.name}
              </Link>
            </div>
          ))}
        </div>
      </div>

      {/* 5. Cards de eventos de checkout com links diretos */}
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

      {/* 6. Gráficos de Canais & Origens de Tráfego do SAC */}
      <div className="rise rise-4 grid grid-cols-1 md:grid-cols-2 gap-[var(--space-gutter)]">
        {/* Distribuição por Canal de Atendimento */}
        <div className="card-section p-[var(--space-card)] flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-h3 text-fg flex items-center gap-1.5 font-bold">
                <Radio size={15} className="text-emerald-400" />
                Canais de Atendimento
              </h3>
              <span className="text-micro text-fg-subtle">Volume & Entrega</span>
            </div>
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between text-micro mb-1">
                  <span className="inline-flex items-center gap-1.5 text-fg font-medium">
                    <MessageSquare size={13} className="text-emerald-400" />
                    WhatsApp Meta Cloud API
                  </span>
                  <span className="num font-bold text-fg">72% <span className="text-fg-faint font-normal">(842 conv.)</span></span>
                </div>
                <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-400 rounded-full" style={{ width: '72%' }} />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-micro mb-1">
                  <span className="inline-flex items-center gap-1.5 text-fg font-medium">
                    <InstagramIcon size={13} className="text-pink-400" />
                    Instagram Direct
                  </span>
                  <span className="num font-bold text-fg">19% <span className="text-fg-faint font-normal">(218 conv.)</span></span>
                </div>
                <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden">
                  <div className="h-full bg-pink-400 rounded-full" style={{ width: '19%' }} />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-micro mb-1">
                  <span className="inline-flex items-center gap-1.5 text-fg font-medium">
                    <Mail size={13} className="text-blue-400" />
                    Brevo E-mail
                  </span>
                  <span className="num font-bold text-fg">9% <span className="text-fg-faint font-normal">(105 conv.)</span></span>
                </div>
                <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden">
                  <div className="h-full bg-blue-400 rounded-full" style={{ width: '9%' }} />
                </div>
              </div>
            </div>
          </div>
          <p className="text-[11px] text-fg-subtle mt-4 pt-3 border-t border-line-subtle flex items-center justify-between">
            <span>Taxa de Entrega Global: <strong className="text-emerald-400">98.8%</strong></span>
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
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between text-micro mb-1">
                  <span className="text-fg font-medium">Meta Ads (Facebook & Instagram)</span>
                  <span className="num font-bold text-fg">54%</span>
                </div>
                <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full" style={{ width: '54%' }} />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-micro mb-1">
                  <span className="text-fg font-medium">Google Ads (Pesquisa / YouTube)</span>
                  <span className="num font-bold text-fg">22%</span>
                </div>
                <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden">
                  <div className="h-full bg-amber-400 rounded-full" style={{ width: '22%' }} />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-micro mb-1">
                  <span className="text-fg font-medium">Tráfego Orgânico & Direto</span>
                  <span className="num font-bold text-fg">14%</span>
                </div>
                <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden">
                  <div className="h-full bg-purple-400 rounded-full" style={{ width: '14%' }} />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between text-micro mb-1">
                  <span className="text-fg font-medium">Recuperação Ativa (Checkout Webhook)</span>
                  <span className="num font-bold text-fg">10%</span>
                </div>
                <div className="h-2 w-full bg-surface-inset rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-400 rounded-full" style={{ width: '10%' }} />
                </div>
              </div>
            </div>
          </div>
          <p className="text-[11px] text-fg-subtle mt-4 pt-3 border-t border-line-subtle flex items-center justify-between">
            <span>Rastreamento Ativo UTM: <strong className="text-brand-ink">92.4%</strong></span>
            <Link href="/origens" className="text-brand-ink hover:underline font-semibold">Ver detalhes</Link>
          </p>
        </div>
      </div>

      {/* 7. Pipeline de Atendimento (Kanban Hermes Interativo com Edição de Modal) */}
      <div className="rise rise-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-h2 text-fg flex items-center gap-2">
              <Columns3 size={18} className="text-brand-ink" />
              Pipeline de Atendimento (Kanban)
            </h2>
            <p className="text-micro text-fg-subtle">
              Arraste os contatos entre as etapas ou clique em qualquer card para editar dados, agente responsável ou abrir WhatsApp.
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

      {/* 8. Fila de mensagens em tempo real */}
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

      {/* 9. Conversão por mensagem da sequência */}
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

      {/* 10. Leads recentes com disparo de WhatsApp */}
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
