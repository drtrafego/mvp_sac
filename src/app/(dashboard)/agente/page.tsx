export const dynamic = 'force-dynamic'

import { PageHeader } from '@/components/ui/page-header'
import Link from 'next/link'
import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { recoverySequences, sequenceMessages, recoveryLeads, messageJobs } from '@/lib/db/schema'
import { eq, and, sql, gte } from 'drizzle-orm'
import { Info, ListOrdered, ArrowRight, Columns3, Bot } from 'lucide-react'
import { AgentNameCard } from '@/components/agente/agent-name-card'
import { AgendaSection } from '@/components/agente/agenda-section'
import { FollowupCard } from '@/components/followup/followup-card'
import { getFollowupConfigReal, getFollowupSentStatsReal } from '@/lib/followup-server'

export default async function AgentePage() {
  const company = await requireCompany()
  const [{ config: followupConfigData, agentSlug, isSharedDbConnected }, followupStats] = await Promise.all([
    getFollowupConfigReal(company.slug, company.id),
    getFollowupSentStatsReal(company.slug, company.id),
  ])

  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const [[sequenceStats], [messageStats], [pendingJobStats], [reminderStats]] = await Promise.all([
    db
      .select({
        total: sql<number>`cast(count(*) as int)`,
        ativas: sql<number>`cast(count(*) filter (where ${recoverySequences.isActive} = true) as int)`,
      })
      .from(recoverySequences)
      .where(eq(recoverySequences.companyId, company.id)),

    db
      .select({
        total: sql<number>`cast(count(*) as int)`,
        ativas: sql<number>`cast(count(*) filter (where ${sequenceMessages.isActive} = true) as int)`,
      })
      .from(sequenceMessages)
      .innerJoin(recoverySequences, eq(sequenceMessages.sequenceId, recoverySequences.id))
      .where(eq(recoverySequences.companyId, company.id)),

    db
      .select({
        total: sql<number>`cast(count(*) as int)`,
      })
      .from(messageJobs)
      .innerJoin(recoveryLeads, eq(messageJobs.leadId, recoveryLeads.id))
      .where(and(eq(recoveryLeads.companyId, company.id), eq(messageJobs.status, 'pending'))),

    db
      .select({
        total: sql<number>`cast(count(*) as int)`,
      })
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.companyId, company.id), gte(recoveryLeads.followUpDate, startOfToday))),
  ])

  return (
    <div className="max-w-[880px] flex flex-col gap-[var(--space-section)]">
      <PageHeader
        icon={<Bot size={22} />}
        title="Agente"
        description={<>
          O cérebro do bot de atendimento da <strong>{company.name}</strong>: nome, horário de funcionamento,
          bloqueios de agenda e a régua de follow-up automática.
        </>}
      />

      <div className="rounded-[var(--r-md)] border border-brand-solid/30 bg-brand-solid/5 p-4 flex items-start gap-3">
        <Info size={18} className="text-brand-solid shrink-0 mt-0.5" />
        <p className="text-body text-fg-muted">
          Esta aba é pra <strong className="text-fg">ver e ajustar configurações</strong> do agente (nome, agenda,
          status do follow-up). <strong className="text-fg">O jeito dele conversar não é editável por aqui</strong>
          {' '}— isso é comportamento de IA, treinado à parte.
        </p>
      </div>

      <AgentNameCard />

      <FollowupCard
        initialConfig={followupConfigData}
        initialStats={followupStats}
        initialAgentSlug={agentSlug}
        initialIsSharedDbConnected={isSharedDbConnected}
      />

      <AgendaSection />

      {/* Follow-up: status real das sequências e da fila, sem inventar edição que não existe aqui */}
      <section className="panel space-y-4 p-[var(--space-card)]">
        <div className="flex items-center gap-2">
          <ListOrdered size={16} className="text-fg-subtle" />
          <h2 className="text-h2 text-fg">Follow-up</h2>
        </div>
        <p className="text-body text-fg-muted">
          Status real da régua de recuperação automática e dos lembretes manuais do Pipeline. O conteúdo das
          mensagens é gerenciado pela integração oficial, não por aqui.
        </p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle p-3">
            <p className="text-h2 text-fg num">{sequenceStats?.ativas ?? 0}<span className="text-fg-faint text-body">/{sequenceStats?.total ?? 0}</span></p>
            <p className="text-micro text-fg-subtle mt-0.5">Sequências ativas</p>
          </div>
          <div className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle p-3">
            <p className="text-h2 text-fg num">{messageStats?.ativas ?? 0}<span className="text-fg-faint text-body">/{messageStats?.total ?? 0}</span></p>
            <p className="text-micro text-fg-subtle mt-0.5">Mensagens configuradas</p>
          </div>
          <div className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle p-3">
            <p className="text-h2 text-fg num">{pendingJobStats?.total ?? 0}</p>
            <p className="text-micro text-fg-subtle mt-0.5">Na fila pra enviar</p>
          </div>
          <div className="rounded-[var(--r-md)] bg-surface-inset border border-line-subtle p-3">
            <p className="text-h2 text-fg num">{reminderStats?.total ?? 0}</p>
            <p className="text-micro text-fg-subtle mt-0.5">Retornos agendados no Pipeline (a partir de hoje)</p>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Link
            href="/api-followup"
            className="focus-ring inline-flex items-center gap-1.5 text-body text-brand-ink hover:underline"
          >
            Ver a régua completa de follow-up <ArrowRight size={14} />
          </Link>
          <Link
            href="/pipeline"
            className="focus-ring inline-flex items-center gap-1.5 text-body text-fg-subtle hover:text-fg hover:underline sm:ml-auto"
          >
            <Columns3 size={14} /> Ver lembretes no Pipeline
          </Link>
        </div>
      </section>
    </div>
  )
}
