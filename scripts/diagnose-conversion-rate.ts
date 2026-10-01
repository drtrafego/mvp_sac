import { db } from '../src/lib/db'
import { companies, recoveryLeads, webhookReceived, metaConversionEvents } from '../src/lib/db/schema'
import { eq, and, gte, lte, count, sql, desc } from 'drizzle-orm'
import { dashboardLeadStatsSelect, resolveDashboardBusinessModel, dashboardBusinessWonSql } from '../src/lib/dashboard/lead-stats'

async function diagnose() {
  console.log('🔍 Diagnosticando taxas de conversão e eventos para TODAS as empresas...')
  const allCompanies = await db.select().from(companies)
  console.log(`Encontradas ${allCompanies.length} empresas no banco.\n`)

  const fromDate = new Date('2026-09-01T00:00:00-03:00')
  const toDate = new Date('2026-10-01T23:59:59-03:00')

  for (const comp of allCompanies) {
    const model = resolveDashboardBusinessModel(comp.slug)
    const baseWhere = and(
      eq(recoveryLeads.companyId, comp.id),
      gte(recoveryLeads.createdAt, fromDate),
      lte(recoveryLeads.createdAt, toDate)
    )

    const [stats] = await db
      .select(dashboardLeadStatsSelect(model))
      .from(recoveryLeads)
      .where(baseWhere)

    // Leads no período
    const [totalLeads] = await db
      .select({ count: count() })
      .from(recoveryLeads)
      .where(baseWhere)

    // Leads por status e pipelineStage
    const leadsByStage = await db
      .select({
        status: recoveryLeads.status,
        pipelineStage: recoveryLeads.pipelineStage,
        eventType: recoveryLeads.eventType,
        hasFirstContact: sql<boolean>`${recoveryLeads.firstContactAt} is not null`,
        cnt: count(),
      })
      .from(recoveryLeads)
      .where(baseWhere)
      .groupBy(recoveryLeads.status, recoveryLeads.pipelineStage, recoveryLeads.eventType, sql`${recoveryLeads.firstContactAt} is not null`)

    // Webhooks de conversão recebidos (hermes) no período
    const hermesWebhooks = await db
      .select({
        processed: webhookReceived.processed,
        skipReason: webhookReceived.skipReason,
        cnt: count(),
      })
      .from(webhookReceived)
      .where(and(eq(webhookReceived.companyId, comp.id), eq(webhookReceived.source, 'hermes')))
      .groupBy(webhookReceived.processed, webhookReceived.skipReason)

    console.log(`═══════════════════════════════════════════════════════════════`)
    console.log(`EMPRESA: [ID ${comp.id}] ${comp.name} (slug: ${comp.slug})`)
    console.log(`Modelo de Negócio Identificado: ${model}`)
    console.log(`Leads Totais (criados 01/09 a 01/10): ${totalLeads.count}`)
    console.log(`Leads com Abordagem (firstContactAt != null): ${stats.total}`)
    console.log(`Fechados / Agendados (Business Won): ${stats.fechadosTotal}`)
    
    const rateWithGate = stats.total > 0 ? ((stats.fechadosTotal / stats.total) * 100).toFixed(1) : '0.0'
    const rateWithoutGate = totalLeads.count > 0 ? ((stats.fechadosTotal / totalLeads.count) * 100).toFixed(1) : '0.0'
    console.log(`Taxa de Conversão (com gate firstContactAt): ${rateWithGate}%`)
    console.log(`Taxa de Conversão (sem gate total bruto): ${rateWithoutGate}%`)

    if (hermesWebhooks.length > 0) {
      console.log(`Webhooks Hermes Recebidos:`, hermesWebhooks)
    }

    console.log(`Detalhamento dos Leads por Status/Stage/FirstContact:`)
    for (const l of leadsByStage) {
      console.log(`  - status="${l.status}", stage="${l.pipelineStage}", event="${l.eventType}", abordado=${l.hasFirstContact} -> ${l.cnt} leads`)
    }
    console.log(`\n`)
  }

  process.exit(0)
}

diagnose().catch(err => {
  console.error('Erro no diagnóstico:', err)
  process.exit(1)
})
