import { and, count, eq, gte, lte } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentActivityLogs } from '@/lib/db/schema'

export type AgentMetric = {
  id: string | null
  name: string
  totalActions: number
  actions: Record<string, number>
}

export type AgentMetrics = {
  source: 'agent_activity_logs'
  totalActions: number
  agents: AgentMetric[]
}

/** Aggregates audit records inside one tenant and time window. */
export async function loadAgentMetrics(companyId: number, fromDate: Date, toDate: Date): Promise<AgentMetrics> {
  const rows = await db
    .select({
      agentId: agentActivityLogs.agentId,
      agentName: agentActivityLogs.agentName,
      action: agentActivityLogs.action,
      total: count(),
    })
    .from(agentActivityLogs)
    .where(and(
      eq(agentActivityLogs.companyId, companyId),
      gte(agentActivityLogs.createdAt, fromDate),
      lte(agentActivityLogs.createdAt, toDate),
    ))
    .groupBy(agentActivityLogs.agentId, agentActivityLogs.agentName, agentActivityLogs.action)

  const agents = new Map<string, AgentMetric>()
  for (const row of rows) {
    const key = row.agentId ?? row.agentName
    const agent = agents.get(key) ?? {
      id: row.agentId,
      name: row.agentName,
      totalActions: 0,
      actions: {},
    }
    const total = Number(row.total)
    agent.totalActions += total
    agent.actions[row.action] = total
    agents.set(key, agent)
  }

  const sortedAgents = [...agents.values()].sort((a, b) =>
    b.totalActions - a.totalActions || a.name.localeCompare(b.name, 'pt-BR'),
  )

  return {
    source: 'agent_activity_logs',
    totalActions: sortedAgents.reduce((total, agent) => total + agent.totalActions, 0),
    agents: sortedAgents,
  }
}
