export const dynamic = 'force-dynamic'

import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, desc, and, gte, lte } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { KanbanBoard, KanbanLead } from '@/components/pipeline/kanban-board'
import { GitCommit, Bot, Sparkles, Columns3 } from 'lucide-react'
import PeriodBar from '@/components/shared/PeriodBar'
import { resolvePeriod } from '@/lib/period'
import { Suspense } from 'react'

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string; period?: string }>
}

export default async function PipelinePage({ searchParams }: PageProps) {
  const [company, params] = await Promise.all([requireCompany(), searchParams])
  
  const { from, to } = resolvePeriod(params)
  const fromDate = new Date(`${from}T00:00:00-03:00`)
  const toDate = new Date(`${to}T23:59:59.999-03:00`)

  const rawLeads = await db
    .select()
    .from(recoveryLeads)
    .where(
      and(
        eq(recoveryLeads.companyId, company.id),
        gte(recoveryLeads.createdAt, fromDate),
        lte(recoveryLeads.createdAt, toDate),
      )
    )
    .orderBy(desc(recoveryLeads.createdAt))

  // Mapear eventos e status para as etapas do Pipeline
  const leads: KanbanLead[] = rawLeads.map((l) => {
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
