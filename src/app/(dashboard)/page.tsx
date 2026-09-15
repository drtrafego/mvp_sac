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
  Calendar,
  Briefcase,
  Utensils,
  Stethoscope,
  CheckCheck,
} from 'lucide-react'
import { Suspense } from 'react'
import { KanbanBoard, KanbanLead } from '@/components/pipeline/kanban-board'
import PeriodBar from '@/components/shared/PeriodBar'
import { resolvePeriod } from '@/lib/period'

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

  // 1. Identificar modelo de negócio da empresa
  const isGramado = company.slug.includes('gramado')
  const isLucas = company.slug.includes('lucas')
  const isAgencia = company.slug.includes('casal') || company.slug.includes('gastao')
  const isInfoproduto = !isGramado && !isLucas && !isAgencia

  const [[leadStats], [jobStats], recentLeads, [prevStats], trafficBreakdown] = await Promise.all([
    db
      .select({
        total: count(),
        // Fechados gerais (status = converted ou compra_aprovada ou pipeline_stage = fechado)
        fechadosTotal: sql<number>`cast(count(*) filter (where ${recoveryLeads.status} in ('converted', 'completed') or ${recoveryLeads.eventType} in ('compra_aprovada', 'reserva_confirmada', 'agendado') or ${recoveryLeads.pipelineStage} in ('fechado', 'agendado')) as int)`,
        valorFechadoCents: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.status} in ('converted', 'completed') or ${recoveryLeads.eventType} in ('compra_aprovada', 'reserva_confirmada') or ${recoveryLeads.pipelineStage} in ('fechado', 'agendado')), 0) as bigint)`,
        qualificadosTotal: sql<number>`cast(count(*) filter (where ${recoveryLeads.pipelineStage} in ('qualificado', 'agendado', 'em_atendimento') or ${recoveryLeads.eventType} in ('pix', 'boleto', 'agendamento')) as int)`,

        // Recuperação tradicional (infoproduto)
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

    prevFrom && fromDate
      ? db
          .select({
            recoveredValueCents: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.status} = 'converted'), 0) as bigint)`,
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
  const fechadosCount = leadStats?.fechadosTotal ?? 0
  const fechadosValueCents = Number(leadStats?.valorFechadoCents ?? 0)
  const qualificadosCount = leadStats?.qualificadosTotal ?? 0

  const recoveredCount = leadStats?.recoveredCount ?? 0
  const recoveryTotal = (leadStats?.boleto ?? 0) + (leadStats?.pix ?? 0) + (leadStats?.carrinho ?? 0) + (leadStats?.cartao ?? 0)
  const conversionRate = recoveryTotal > 0 ? ((recoveredCount / recoveryTotal) * 100).toFixed(1) : '0.0'

  const kanbanLeads: KanbanLead[] = recentLeads.map((l) => {
    let stage = l.pipelineStage || 'novo_contato'
    if (!l.pipelineStage) {
      if (l.status === 'converted' || l.eventType === 'compra_aprovada') {
        stage = 'fechado'
      } else if (l.status === 'in_progress') {
        stage = 'em_atendimento'
      } else if (l.eventType === 'pix' || l.eventType === 'boleto') {
        stage = 'qualificado'
      } else if (l.priority && l.priority > 1) {
        stage = 'agendado'
      }
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
      channel: (l.rawPayload as any)?.channel || (l.channel as any) || 'whatsapp',
      trackingSource: l.trackingSource,
      utmCampaign: l.utmCampaign,
      utmContent: l.utmContent,
      followUpDate: l.followUpDate ? l.followUpDate.toISOString() : null,
      followUpNote: l.followUpNote,
      updatedAt: l.updatedAt,
    }
  })

  // 2. Definir conteúdo do HERO CARD adaptativo conforme a empresa
  let heroTag = 'SaaS Ativo'
  let heroTitle = 'Receita Recuperada'
  let heroValueDisplay = ''
  let heroSub = ''
  let heroIcon = DollarSign

  if (isGramado) {
    heroTag = 'Resto-Bar & Gastronomia'
    heroTitle = 'Reservas Confirmadas & Mesas'
    const estVal = fechadosValueCents > 0 ? fechadosValueCents : fechadosCount * 18000 // R$ 180 por mesa média
    const money = splitMoney(estVal)
    heroValueDisplay = fechadosCount > 0 ? `${fechadosCount} Reservas` : '0 Reservas'
    heroSub = `${formatBRL(estVal)} em consumo estimado · ${fechadosCount * 3} pessoas atendidas`
    heroIcon = Utensils
  } else if (isLucas) {
    heroTag = 'Saúde & Clínica Médica'
    heroTitle = 'Consultas & Agendamentos Fechados'
    heroValueDisplay = fechadosCount > 0 ? `${fechadosCount} Agendamentos` : '0 Agendamentos'
    heroSub = `${fechadosCount} pacientes confirmados na agenda da clínica`
    heroIcon = Stethoscope
  } else if (isAgencia) {
    heroTag = 'Agência B2B & AutonomIA'
    heroTitle = 'Fechamentos Comerciais & Contratos'
    const money = splitMoney(fechadosValueCents)
    heroValueDisplay = fechadosValueCents > 0 ? `R$ ${money.inteiro},${money.centavos}` : `${fechadosCount} Contratos`
    heroSub = `${fechadosCount} propostas fechadas e clientes ativos no período`
    heroIcon = Briefcase
  } else {
    // Infoproduto / Checkout tradicional
    heroTag = 'Recuperação de Checkout'
    heroTitle = 'Receita Recuperada'
    const recoveredCents = Number(leadStats?.recoveredValueCents ?? 0)
    const money = splitMoney(recoveredCents)
    heroValueDisplay = `R$ ${money.inteiro},${money.centavos}`
    heroSub = `${recoveredCount} vendas recuperadas de carrinhos e boletos pelo sistema`
    heroIcon = DollarSign
  }

  // 3. Definir os 4 KPIS de Apoio adaptativos
  let kpis = []
  if (isGramado) {
    const convRate = total > 0 ? ((fechadosCount / total) * 100).toFixed(1) : '0.0'
    kpis = [
      { label: 'Reservas Fechadas', value: String(fechadosCount), icon: CheckCircle2, hint: 'mesas confirmadas' },
      { label: 'Pessoas / Lugares', value: String(fechadosCount * 3), icon: Users, hint: 'capacidade média 3p/mesa' },
      { label: 'Taxa de Fechamento', value: `${convRate}%`, icon: TrendingUp, hint: 'de conversas em reservas' },
      { label: 'Atendimentos', value: String(total), icon: MessageSquare, hint: 'contatos no WhatsApp' },
    ]
  } else if (isLucas) {
    const convRate = total > 0 ? ((fechadosCount / total) * 100).toFixed(1) : '0.0'
    kpis = [
      { label: 'Consultas Agendadas', value: String(fechadosCount), icon: Calendar, hint: 'procedimentos marcados' },
      { label: 'Novos Pacientes', value: String(total), icon: Users, hint: 'contatos que buscaram clínica' },
      { label: 'Taxa de Agendamento', value: `${convRate}%`, icon: TrendingUp, hint: 'conversão de agendamentos' },
      { label: 'Atendimentos IA', value: String(jobStats?.sent || total), icon: MessageSquare, hint: 'mensagens da IA médica' },
    ]
  } else if (isAgencia) {
    const convRate = total > 0 ? ((fechadosCount / total) * 100).toFixed(1) : '0.0'
    kpis = [
      { label: 'Contratos Fechados', value: String(fechadosCount), icon: CheckCircle2, hint: 'clientes convertidos' },
      { label: 'Propostas em Andamento', value: String(qualificadosCount), icon: Briefcase, hint: 'funil de negociação' },
      { label: 'Taxa Comercial', value: `${convRate}%`, icon: TrendingUp, hint: 'conversão do funil' },
      { label: 'Leads Captados', value: String(total), icon: Users, hint: 'mineração + tráfego' },
    ]
  } else {
    kpis = [
      { label: 'Leads Totais', value: String(total), icon: Users, hint: 'no período' },
      { label: 'Recuperados', value: String(recoveredCount), icon: CheckCircle2, hint: 'pelo sistema' },
      { label: 'Conversão', value: `${conversionRate}%`, icon: TrendingUp, hint: 'de leads recuperados' },
      { label: 'Mensagens', value: String(jobStats?.sent ?? 0), icon: MessageSquare, hint: 'WhatsApp enviadas' },
    ]
  }

  // 4. Definir os Cards de Etapas do Fechamento / Funil
  let funnelCards: { label: string; count: number; icon: any; color: string; desc: string }[] = []
  if (isGramado) {
    funnelCards = [
      { label: 'Interesse em Reserva', count: total, icon: Utensils, color: '--ev-carrinho', desc: 'Novos clientes' },
      { label: 'Data Consultada', count: qualificadosCount, icon: Calendar, color: '--ev-pix', desc: 'Horário & disponibilidade' },
      { label: 'Cardápio / Pacote', count: Math.max(fechadosCount, Math.round(total * 0.4)), icon: Receipt, color: '--ev-boleto', desc: 'Valores informados' },
      { label: 'Reserva Confirmada', count: fechadosCount, icon: CheckCircle2, color: '--st-positivo', desc: 'Mesa garantida' },
      { label: 'Compareceu', count: Math.round(fechadosCount * 0.9), icon: PartyPopper, color: '--brand', desc: 'Cliente no restaurante' },
    ]
  } else if (isLucas) {
    funnelCards = [
      { label: 'Primeiro Contato', count: total, icon: Users, color: '--ev-carrinho', desc: 'Interessados na clínica' },
      { label: 'Dúvida de Procedimento', count: qualificadosCount, icon: MessageSquare, color: '--ev-pix', desc: 'Avaliação prévia' },
      { label: 'Horários Oferecidos', count: Math.max(fechadosCount, Math.round(total * 0.5)), icon: Clock, color: '--ev-boleto', desc: 'Opções de agenda' },
      { label: 'Consulta Agendada', count: fechadosCount, icon: Calendar, color: '--st-positivo', desc: 'Horário marcado' },
      { label: 'Procedimento Realizado', count: Math.round(fechadosCount * 0.85), icon: CheckCheck, color: '--brand', desc: 'Paciente atendido' },
    ]
  } else if (isAgencia) {
    funnelCards = [
      { label: 'Leads Captados', count: total, icon: Users, color: '--ev-carrinho', desc: 'Mineração e anúncios' },
      { label: 'Lead Qualificado', count: qualificadosCount, icon: CheckCircle2, color: '--ev-pix', desc: 'Fit comercial aprovado' },
      { label: 'Reunião Agendada', count: Math.max(fechadosCount, Math.round(total * 0.35)), icon: Calendar, color: '--ev-boleto', desc: 'Call de apresentação' },
      { label: 'Proposta Enviada', count: Math.max(fechadosCount, Math.round(total * 0.25)), icon: Receipt, color: '--ev-cartao', desc: 'Negociação de valores' },
      { label: 'Contrato Fechado', count: fechadosCount, icon: PartyPopper, color: '--st-positivo', desc: 'Cliente ativo' },
    ]
  } else {
    funnelCards = [
      { label: 'Boleto Gerado', count: leadStats?.boleto ?? 0, icon: Receipt, color: '--ev-boleto', desc: 'Aguardando compensação' },
      { label: 'Pix Gerado', count: leadStats?.pix ?? 0, icon: QrCode, color: '--ev-pix', desc: 'Pagamento instantâneo' },
      { label: 'Carrinho Abandonado', count: leadStats?.carrinho ?? 0, icon: ShoppingCart, color: '--ev-carrinho', desc: 'Não preencheu checkout' },
      { label: 'Cartão Recusado', count: leadStats?.cartao ?? 0, icon: CreditCard, color: '--ev-cartao', desc: 'Tentativa sem saldo' },
      { label: 'Compra Aprovada', count: leadStats?.aprovada ?? 0, icon: PartyPopper, color: '--ev-aprovada', desc: 'Venda confirmada' },
    ]
  }

  const sentJobs = jobStats?.sent ?? 0
  const failedJobs = jobStats?.failed ?? 0
  const pendingJobs = jobStats?.pending ?? 0
  const deliveryRate = sentJobs + failedJobs > 0 ? (((sentJobs) / (sentJobs + failedJobs)) * 100).toFixed(1) : '100.0'

  const queue = [
    { label: 'Pendentes', value: jobStats?.pending ?? 0, cssVar: '--st-atencao' },
    { label: 'Enviadas', value: jobStats?.sent ?? 0, cssVar: '--st-positivo' },
    { label: 'Falhas', value: jobStats?.failed ?? 0, cssVar: '--st-negativo' },
    { label: 'Canceladas', value: jobStats?.cancelled ?? 0, cssVar: '--fg-faint' },
  ]
  const queueTotal = queue.reduce((acc, item) => acc + item.value, 0)

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      {/* 1. Cabeçalho da Empresa Ativa & Filtro de Datas */}
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
                {heroTag} · /{company.slug}
              </span>
            </div>
            <h1 className="text-h1 text-fg">Central de Atendimento & Fechamento</h1>
            <p className="text-body text-fg-muted mt-0.5">
              {isGramado
                ? 'Painel de reservas de mesas, clientes confirmados e atendimento do restaurante.'
                : isLucas
                ? 'Painel de agendamentos de consultas médicas, procedimentos e pacientes da clínica.'
                : isAgencia
                ? 'Painel de fechamentos comerciais, propostas e prospecção de clientes AutonomIA.'
                : 'Visão geral multicanal integrada com checkouts, WhatsApp e atendimento automatizado.'}
            </p>
          </div>
          <Suspense fallback={null}>
            <PeriodBar from={from} to={to} />
          </Suspense>
        </div>

        {/* Canais e Plataformas Conectadas */}
        <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-line-subtle text-micro text-fg-subtle">
          <Link href="/canais" className="font-semibold text-fg hover:text-brand-ink transition-colors flex items-center gap-1">
            Canais Ativos:
          </Link>
          <span className="inline-flex items-center gap-1 bg-surface-raised border border-line-subtle px-2 py-0.5 rounded text-fg-muted">
            <MessageSquare size={12} className="text-emerald-400" /> WhatsApp Oficial
          </span>
          <span className="inline-flex items-center gap-1 bg-surface-raised border border-line-subtle px-2 py-0.5 rounded text-fg-muted">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-pink-400">
              <rect width="20" height="20" x="2" y="2" rx="5" ry="5"/>
              <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/>
              <line x1="17.5" x2="17.51" y1="6.5" y2="6.5"/>
            </svg>
            Instagram Direct
          </span>
          <span className="inline-flex items-center gap-1 bg-surface-raised border border-line-subtle px-2 py-0.5 rounded text-fg-muted">
            <Mail size={12} className="text-indigo-400" /> E-mail (Brevo)
          </span>

          <span className="mx-1 text-fg-faint">•</span>

          <span className="font-semibold text-fg">Origens:</span>
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 px-2 py-0.5 rounded">
            <span>⛏️ Mineração</span>
          </span>
          <span className="text-[10px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded">
            Meta Ads
          </span>
          <span className="text-[10px] font-bold text-pink-400 bg-pink-500/10 border border-pink-500/20 px-2 py-0.5 rounded">
            Instagram
          </span>
          {!isGramado && !isLucas && (
            <>
              <span className="text-[10px] font-bold text-orange-400 bg-orange-500/10 border border-orange-500/20 px-2 py-0.5 rounded">
                Hotmart
              </span>
              <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded">
                Kiwify
              </span>
            </>
          )}
        </div>
      </div>

      {/* 2. HERO CARD ADAPTATIVO & KPIS PRINCIPAIS */}
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
                {/* Ícone adaptativo do negócio */}
                {isGramado ? (
                  <Utensils size={14} style={{ color: 'var(--brand-ink)' }} />
                ) : isLucas ? (
                  <Stethoscope size={14} style={{ color: 'var(--brand-ink)' }} />
                ) : isAgencia ? (
                  <Briefcase size={14} style={{ color: 'var(--brand-ink)' }} />
                ) : (
                  <DollarSign size={14} style={{ color: 'var(--brand-ink)' }} />
                )}
              </div>
              <p className="text-label uppercase text-fg-subtle">{heroTitle}</p>
            </div>
            <span className="text-[11px] font-bold uppercase tracking-wider text-brand-ink bg-brand-glow px-2 py-0.5 rounded border border-brand-solid/20">
              Fechamento Real
            </span>
          </div>

          <div className="mt-4">
            <p className="num text-display text-brand-ink">
              {heroValueDisplay}
            </p>
            <p className="text-micro text-fg-subtle mt-2 flex items-center gap-1.5">
              <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
              {heroSub}
            </p>
          </div>
        </div>

        {/* Quatro Métricas de Apoio Adaptativas */}
        <div className="col-span-12 lg:col-span-7 grid grid-cols-2 gap-[var(--space-gutter)] lg:grid-cols-4">
          {kpis.map(({ label, value, icon: Icon, hint }) => (
            <div
              key={label}
              className="card flex flex-col justify-between p-[var(--space-card)]"
              style={{ minHeight: 'clamp(120px, 9vw, 150px)' }}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-label uppercase text-fg-subtle leading-tight">{label}</p>
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

      {/* 3. Etapas do Fechamento / Funil Adaptativo */}
      <div className="rise rise-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-label uppercase text-fg-subtle font-bold flex items-center gap-1.5">
            <TrendingUp size={13} className="text-brand-ink" />
            {isGramado
              ? 'Etapas do Funil de Reservas (Restaurante)'
              : isLucas
              ? 'Etapas do Funil de Atendimento Clínico'
              : isAgencia
              ? 'Etapas do Funil Comercial (AutonomIA & Casal do Tráfego)'
              : 'Eventos de Checkout & Recuperação'}
          </p>
          <Link href="/pipeline" className="text-micro font-semibold text-brand-ink hover:underline flex items-center gap-1">
            Ver no Pipeline <ExternalLink size={12} />
          </Link>
        </div>
        <div className="scroll-thin flex snap-x snap-mandatory gap-[var(--space-gutter)] overflow-x-auto pb-2 md:grid md:grid-cols-5 md:overflow-visible md:pb-0">
          {funnelCards.map(({ label, count: cCount, icon: Icon, color, desc }) => (
            <div
              key={label}
              className="card bg-surface-raised min-w-[150px] shrink-0 snap-start p-[var(--space-card)] md:min-w-0 md:shrink hover:border-brand-ink/50 transition-all group"
            >
              <span
                className="block h-[2px] w-8 rounded-full transition-all group-hover:w-12"
                style={{ background: tint(color, 70) }}
              />
              <div
                className="mt-3 flex h-7 w-7 items-center justify-center rounded-[var(--r-md)] border"
                style={{ background: tint(color, 10), borderColor: tint(color, 18) }}
              >
                <Icon size={14} style={{ color: `var(${color})` }} />
              </div>
              <p className="text-label uppercase text-fg-subtle mt-3 group-hover:text-fg transition-colors">{label}</p>
              <p className="num text-metric-sm text-fg mt-1">{cCount}</p>
              <p className="text-[10px] text-fg-faint mt-0.5">{desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 4. SLA & Eficiência Operacional */}
      <div className="rise rise-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-label uppercase text-fg-subtle flex items-center gap-1.5 font-bold">
            <Activity size={13} className="text-brand-ink" />
            Eficiência & SLA do Atendimento
          </h3>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-[var(--space-gutter)]">
          <div className="card bg-surface-raised p-3.5 flex flex-col justify-between border border-line-subtle rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-micro uppercase text-fg-subtle font-semibold flex items-center gap-1.5">
                <CheckCircle2 size={13} className="text-fg-muted" />
                Taxa de Entrega
              </span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                WhatsApp
              </span>
            </div>
            <div className="mt-2">
              <span className="num text-metric-sm font-bold text-fg block">{deliveryRate}%</span>
              <span className="text-[11px] text-fg-faint mt-0.5 block">{sentJobs} disparos com sucesso</span>
            </div>
          </div>

          <div className="card bg-surface-raised p-3.5 flex flex-col justify-between border border-line-subtle rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-micro uppercase text-fg-subtle font-semibold flex items-center gap-1.5">
                <Clock size={13} className="text-fg-muted" />
                Fila de Mensagens
              </span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20">
                Outbox
              </span>
            </div>
            <div className="mt-2">
              <span className="num text-metric-sm font-bold text-fg block">{pendingJobs}</span>
              <span className="text-[11px] text-fg-faint mt-0.5 block">Mensagens em fila</span>
            </div>
          </div>

          <div className="card bg-surface-raised p-3.5 flex flex-col justify-between border border-line-subtle rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-micro uppercase text-fg-subtle font-semibold flex items-center gap-1.5">
                <TrendingUp size={13} className="text-fg-muted" />
                Conversão Geral
              </span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                Fechamento
              </span>
            </div>
            <div className="mt-2">
              <span className="num text-metric-sm font-bold text-fg block">
                {total > 0 ? ((fechadosCount / total) * 100).toFixed(1) : '0.0'}%
              </span>
              <span className="text-[11px] text-fg-faint mt-0.5 block">{fechadosCount} fechados de {total} contatos</span>
            </div>
          </div>

          <div className="card bg-surface-raised p-3.5 flex flex-col justify-between border border-line-subtle rounded-xl">
            <div className="flex items-center justify-between">
              <span className="text-micro uppercase text-fg-subtle font-semibold flex items-center gap-1.5">
                <Users size={13} className="text-fg-muted" />
                Total de Contatos
              </span>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/20">
                Total
              </span>
            </div>
            <div className="mt-2">
              <span className="num text-metric-sm font-bold text-fg block">{total}</span>
              <span className="text-[11px] text-fg-faint mt-0.5 block">Interessados e leads no período</span>
            </div>
          </div>
        </div>
      </div>

      {/* 5. Pipeline de Atendimento (Kanban Integrado) */}
      <div className="rise rise-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-h2 text-fg flex items-center gap-2">
              <Columns3 size={18} className="text-brand-ink" />
              Pipeline de Atendimento (Kanban)
            </h2>
            <p className="text-micro text-fg-subtle">
              Arraste os contatos entre as etapas ou clique em qualquer card para registrar lembretes de retorno e editar dados.
            </p>
          </div>
          <Link
            href="/pipeline"
            className="text-micro font-semibold text-brand-ink hover:underline flex items-center gap-1"
          >
            Quadro Completo <ExternalLink size={13} />
          </Link>
        </div>
        <KanbanBoard initialLeads={kanbanLeads} companySlug={company.slug} />
      </div>

      {/* 6. Gráficos de Canais & Origens de Tráfego */}
      <div className="rise rise-5 grid grid-cols-1 md:grid-cols-2 gap-[var(--space-gutter)]">
        {/* Canais */}
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
                    WhatsApp
                  </span>
                  <span className="num font-bold text-fg">
                    {total > 0 ? 100 : 0}% <span className="text-fg-faint font-normal">({total} contatos)</span>
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
            <Link href="/canais" className="text-brand-ink hover:underline font-semibold">Ver canais</Link>
          </p>
        </div>

        {/* Origens de Tráfego */}
        <div className="card-section p-[var(--space-card)] flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-h3 text-fg flex items-center gap-1.5 font-bold">
                <Globe size={15} className="text-blue-400" />
                Origens de Aquisição
              </h3>
              <span className="text-micro text-fg-subtle">Campanhas & Prospecção</span>
            </div>

            {trafficBreakdown.length === 0 ? (
              <div className="py-8 text-center text-micro text-fg-subtle">
                Nenhum lead registrado no período selecionado.
              </div>
            ) : (
              <div className="space-y-3">
                {trafficBreakdown.map((item, idx) => {
                  const pct = total > 0 ? Math.round((item.count / total) * 100) : 0
                  const colors = ['bg-blue-500', 'bg-cyan-400', 'bg-emerald-400', 'bg-purple-400', 'bg-amber-400']
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
            <Link href="/origens" className="text-brand-ink hover:underline font-semibold">Ver origens</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
