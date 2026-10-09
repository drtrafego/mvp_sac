export const dynamic = 'force-dynamic'

import { PageHeader } from '@/components/ui/page-header'
import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoverySequences, sequenceMessages, recoveryLeads } from '@/lib/db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { ListOrdered } from 'lucide-react'
import { FollowupCard } from '@/components/followup/followup-card'
import { getFollowupConfigReal, getFollowupSentStatsReal } from '@/lib/followup-server'

export default async function ApiFollowupPage() {
  const company = await requireCompany()

  const [realConfigData, statsData] = await Promise.all([
    getFollowupConfigReal(company.slug, company.id),
    getFollowupSentStatsReal(company.slug, company.id),
  ])

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <PageHeader
        icon={<ListOrdered size={22} />}
        title="Follow-up Automático de Conversa Parada"
        description={<>
          Configuração de réguas de retomada automática por LLM, janelas de horário e espaçamento randômico para a empresa <strong>{company.name}</strong>.
        </>}
        eyebrow={<>
          <div className="flex items-center gap-2 mb-1">
            <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
              <ListOrdered size={12} />
              Empresa: {company.name} · Automação de Conversa Parada
            </span>
          </div>
        </>}
      />

      <div className="rise rise-2">
        <FollowupCard
          initialConfig={realConfigData.config}
          initialStats={statsData}
          initialAgentSlug={realConfigData.agentSlug}
          initialIsSharedDbConnected={realConfigData.isSharedDbConnected}
        />
      </div>
    </div>
  )
}
