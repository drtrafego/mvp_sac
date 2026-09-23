import { NextResponse } from 'next/server'
import { requireAdmin, unauthorizedResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { companies } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

// Detalhe por empresa (nome, total de contatos, total de mensagens) que
// vivia em /api/v1/health até ele ser corrigido pra parar de vazar isso
// publicamente. Agora exige login de admin — uso interno (diagnóstico), não
// mais um endpoint público.
export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      slug: companies.slug,
      totalLeads: sql<number>`COALESCE((SELECT COUNT(*)::int FROM recovery_leads WHERE recovery_leads.company_id = "companies"."id"), 0)`,
      totalMessages: sql<number>`COALESCE((SELECT COUNT(*)::int FROM whatsapp_messages WHERE whatsapp_messages.company_id = "companies"."id"), 0)`,
    })
    .from(companies)
    .orderBy(companies.id)

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    totalCompanies: rows.length,
    companies: rows,
  })
}
