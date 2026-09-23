export const dynamic = 'force-dynamic'

import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, desc, and, gte, lte } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { KanbanBoard, KanbanLead } from '@/components/pipeline/kanban-board'
import { GitCommit, Bot, Sparkles, Columns3, Target } from 'lucide-react'
import PeriodBar from '@/components/shared/PeriodBar'
import { resolvePeriod } from '@/lib/period'
import { inferPipelineStage } from '@/lib/pipeline-stage'
import { Suspense } from 'react'
import Link from 'next/link'
import { channelWhereCondition } from '@/lib/inbox-channel-filter'

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string; period?: string; source?: string }>
}

// Mesmos rótulos usados em /leads e /origens pro badge de "Filtrando por
// origem" (?source=). Mantido local e enxuto de propósito: só os valores que
// o menu lateral realmente manda pro Pipeline hoje (mineracaoNav).
const SOURCE_FILTER_LABELS: Record<string, string> = {
  instagram: '📸 Instagram',
  mineracao: '⛏️ Mineração',
  whatsapp: '💬 WhatsApp',
  email: '✉️ E-mail',
  anuncio: '📣 Anúncio',
}

export default async function PipelinePage({ searchParams }: PageProps) {
  const [company, params] = await Promise.all([requireCompany(), searchParams])

  const { from, to } = resolvePeriod(params)
  const fromDate = new Date(`${from}T00:00:00-03:00`)
  const toDate = new Date(`${to}T23:59:59.999-03:00`)
  const source = params.source?.trim() || null

  // channelWhereCondition é a ÚNICA fonte da verdade de classificação de
  // canal (src/lib/inbox-channel-filter.ts, mesma usada em /api/inbox e
  // agora em /api/leads): reaproveitada aqui pra "Pipeline Prospecção" não
  // misturar lead de Mineração com todo o resto do funil de vendas.
  const sourceCondition = source ? channelWhereCondition(source) : undefined

  const rawLeads = await db
    .select()
    .from(recoveryLeads)
    .where(
      and(
        eq(recoveryLeads.companyId, company.id),
        gte(recoveryLeads.createdAt, fromDate),
        lte(recoveryLeads.createdAt, toDate),
        sourceCondition,
      )
    )
    .orderBy(desc(recoveryLeads.createdAt))

  // Mapear eventos e status para as etapas do Pipeline
  const leads: KanbanLead[] = rawLeads.map((l) => {
    const stage = inferPipelineStage(l)

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

  return (
    <div className="flex flex-col gap-3 flex-1 min-h-[calc(100vh-5.5rem)] h-[calc(100vh-5rem)] pb-1">
      {/* Cabeçalho do Pipeline */}
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
              <Columns3 size={12} />
              Empresa: {company.name} · Funil de Vendas
            </span>
          </div>
          <h1 className="text-h1 text-fg">Pipeline de Atendimento & Vendas</h1>
          <p className="text-body text-fg-muted mt-0.5">
            Quadro Kanban com etapas personalizadas, lembretes de follow-up e origem das campanhas.
          </p>
          {source && (
            <div className="flex items-center gap-2 text-micro mt-2">
              <span className="inline-flex items-center gap-1.5 font-semibold text-brand-ink bg-brand-glow px-2.5 py-1 rounded-full border border-brand-solid/30">
                <Target size={12} />
                Filtrando por origem: {SOURCE_FILTER_LABELS[source] ?? source} ({leads.length} leads)
              </span>
              <Link
                href={`/pipeline?from=${from}&to=${to}`}
                className="text-fg-subtle hover:text-fg underline underline-offset-2"
              >
                Limpar filtro
              </Link>
            </div>
          )}
        </div>
        <Suspense fallback={null}>
          <PeriodBar from={from} to={to} />
        </Suspense>
      </div>

      {/* Kanban Board Full Height Adaptativo */}
      <div className="flex-1 min-h-0 h-full flex flex-col">
        <KanbanBoard initialLeads={leads} companySlug={company.slug} />
      </div>
    </div>
  )
}
