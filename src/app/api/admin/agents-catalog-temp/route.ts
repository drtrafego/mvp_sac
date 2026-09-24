import { NextResponse } from 'next/server'
import { requireAdmin, unauthorizedResponse } from '@/lib/auth'
import { queryAgentsDb } from '@/lib/db/agents-db'

export const dynamic = 'force-dynamic'

// Rota TEMPORÁRIA (24/09/2026): listar o catálogo de agentes Hermes (nome,
// slug, org) pra decidir a regra de match de sync-agents.ts que falta pra
// ligar o Hermes da Isabela ao SAC. Nenhum dado de conversa/lead, só o
// catálogo de agentes. Apaga depois de usar.
export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const agents = await queryAgentsDb<{
    id: string
    slug: string
    schema_name: string
    name: string
    active: boolean
    org_slug: string
    org_name: string
  }>(`
    select a.id, a.slug, a.schema_name, a.name, a.active,
           o.slug as org_slug, o.name as org_name
    from public.agents a
    left join public.organizations o on o.id = a.organization_id
    order by o.slug, a.slug
  `)

  return NextResponse.json({ agents })
}
