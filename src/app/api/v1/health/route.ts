import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies } from '@/lib/db/schema'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

// ‼️ 23/09/2026: esta rota é PÚBLICA de propósito (health-check simples, sem
// login, pra monitoramento externo). Até hoje ela devolvia nome de TODOS os
// clientes com total de contatos e mensagens de cada um — achado real
// (@analista/ficha-produto-sac.md): qualquer pessoa na internet via a lista
// inteira de clientes do Gastão. O detalhe por empresa mudou pra
// /api/admin/health-detail, que exige login de admin. Esta aqui só confirma
// que o serviço está de pé.
export async function GET() {
  try {
    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(companies)

    return NextResponse.json({
      ok: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
      totalCompanies: count,
    })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 })
  }
}
