export const dynamic = 'force-dynamic'

import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'
import { KanbanBoard, KanbanLead } from '@/components/pipeline/kanban-board'
import { GitCommit, Bot, Sparkles } from 'lucide-react'

export default async function PipelinePage() {
  const company = await requireCompany()

  const rawLeads = await db
    .select()
    .from(recoveryLeads)
    .where(eq(recoveryLeads.companyId, company.id))
    .orderBy(desc(recoveryLeads.createdAt))
    .limit(100)

  // Mapear eventos e status para as 5 etapas do Pipeline
  const leads: KanbanLead[] = rawLeads.map((l) => {
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
      channel: (l.rawPayload as any)?.channel || 'whatsapp',
      updatedAt: l.updatedAt,
    }
  })

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      {/* Cabeçalho do Pipeline */}
      <div className="rise rise-1 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-micro uppercase font-bold text-brand-ink bg-brand-glow px-2 py-0.5 rounded-full border border-brand-solid/30">
              <Sparkles size={12} />
              SAC Multiagente v2
            </span>
          </div>
          <h1 className="text-h1 text-fg mt-1">Pipeline de Atendimento</h1>
          <p className="text-body text-fg-muted">
            Quadro Kanban do funil de vendas, etapas de recuperação e automação dos agentes Hermes.
          </p>
        </div>
      </div>

      {/* Kanban Board */}
      <div className="rise rise-2">
        <KanbanBoard initialLeads={leads} />
      </div>
    </div>
  )
}
