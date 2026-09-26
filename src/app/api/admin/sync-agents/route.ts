export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { syncAgentsAndCompanies } from '@/lib/sync-agents'
import { getAgentsDbUrl } from '@/lib/db/agents-db'
import { getCurrentUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { settings, companies } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser()
  if (!user || !user.isAdmin) {
    return NextResponse.json({ error: 'Acesso restrito ao Super Admin' }, { status: 403 })
  }

  const url = await getAgentsDbUrl()
  const hasEnv = !!(process.env.SUPABASE_DATABASE_URL || process.env.AGENTS_DATABASE_URL)
  const masked = url ? url.replace(/:[^:@]+@/, ':****@') : null

  return NextResponse.json({
    configured: !!url,
    hasEnv,
    url: masked,
  })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser()
  if (!user || !user.isAdmin) {
    return NextResponse.json({ error: 'Acesso restrito ao Super Admin' }, { status: 403 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    if (body.supabaseUrl && typeof body.supabaseUrl === 'string' && body.supabaseUrl.trim()) {
      const cleanUrl = body.supabaseUrl.trim()
      // Achado de auditoria (26/09/2026): esta linha gravava a MESMA URL do
      // banco COMPARTILHADO dos agentes em settings.supabaseDatabaseUrl de
      // TODAS as empresas (loop em allCompanies). settings é uma tabela
      // por-empresa com rota de leitura exposta ao próprio cliente
      // (GET /api/settings, GET/PATCH v1); duplicar aqui fazia a credencial
      // interna vazar pra empresas que não têm nada a ver com ela. A única
      // consumidora real é getAgentsDbUrl() (src/lib/db/agents-db.ts), que
      // faz `select ... where supabaseDatabaseUrl is not null limit 1` sem
      // filtrar por empresa: só precisa de UMA linha preenchida, nunca de N.
      // Fix: grava numa única empresa (a mais antiga por id), não em todas.
      // Isso não muda o comportamento de getAgentsDbUrl() (que já só olhava
      // a primeira linha não nula), só reduz o raio de exposição de N
      // empresas para 1. TODO (fora do escopo desta correção, avaliar com
      // @arquiteto): mover este valor pra uma config global fora da tabela
      // multi-tenant `settings`, e rodar uma limpeza pontual pra zerar
      // supabaseDatabaseUrl das empresas que já ficaram com essa cópia antes
      // deste fix.
      const [primeiraEmpresa] = await db
        .select({ id: companies.id })
        .from(companies)
        .orderBy(companies.id)
        .limit(1)
      if (primeiraEmpresa) {
        await db
          .update(settings)
          .set({ supabaseDatabaseUrl: cleanUrl, updatedAt: new Date() })
          .where(eq(settings.companyId, primeiraEmpresa.id))
      }
    }

    const report = await syncAgentsAndCompanies()
    return NextResponse.json(report)
  } catch (error) {
    console.error('[Sync Agents API Error]:', error)
    return NextResponse.json(
      {
        ok: false,
        error: 'Erro ao sincronizar agentes',
        detail: String(error),
      },
      { status: 500 }
    )
  }
}
