export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { syncAgentsAndCompanies } from '@/lib/sync-agents'
import { getCurrentUser } from '@/lib/auth'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser()
  if (!user || !user.isAdmin) {
    return NextResponse.json({ error: 'Acesso restrito ao Super Admin' }, { status: 403 })
  }

  try {
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  return POST(req)
}
