export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { syncAgentsAndCompanies } from '@/lib/sync-agents'
import { getAgentsDbSourceDiagnostic } from '@/lib/db/agents-db'
import { getCurrentUser } from '@/lib/auth'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser()
  if (!user || !user.isAdmin) {
    return NextResponse.json({ error: 'Acesso restrito ao Super Admin' }, { status: 403 })
  }

  const source = getAgentsDbSourceDiagnostic()

  return NextResponse.json({
    configured: source.status === 'configured',
    hasEnv: source.env === 'AGENTS_DATABASE_URL',
    source,
  })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser()
  if (!user || !user.isAdmin) {
    return NextResponse.json({ error: 'Acesso restrito ao Super Admin' }, { status: 403 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    if (body.supabaseUrl != null) {
      return NextResponse.json(
        {
          ok: false,
          error: 'A fonte dos agentes é somente AGENTS_DATABASE_URL; a configuração por settings.supabaseDatabaseUrl foi desativada.',
        },
        { status: 400 },
      )
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
