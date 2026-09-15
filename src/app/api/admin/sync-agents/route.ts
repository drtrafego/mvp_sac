export const dynamic = 'force-dynamic'

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
      // Salva nas configurações de todas as empresas locais para persistir
      const allCompanies = await db.select({ id: companies.id }).from(companies)
      for (const c of allCompanies) {
        await db
          .update(settings)
          .set({ supabaseDatabaseUrl: cleanUrl, updatedAt: new Date() })
          .where(eq(settings.companyId, c.id))
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
