export const dynamic = 'force-dynamic'
export const maxDuration = 60

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { syncAgentsAndCompanies } from '@/lib/sync-agents'

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// Espelha automaticamente as conversas dos bots Hermes (Nina/AutonomIA e
// demais agentes cadastrados em public.agents) no inbox do SAC: mesma
// função que o botão manual "Sincronizar Agentes" em /empresas já chama,
// só que disparada pelo Vercel Cron em vez de depender de um admin clicar.
// Autenticação por CRON_SECRET (mesmo segredo do /api/cron principal),
// nunca por sessão de admin, porque quem chama aqui é a infraestrutura.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET não configurado' }, { status: 500 })
  }

  const auth = req.headers.get('Authorization') ?? ''
  if (!safeEqual(auth, `Bearer ${cronSecret}`)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const report = await syncAgentsAndCompanies()
    return NextResponse.json(report)
  } catch (error) {
    console.error('[Cron Sync Agents Error]:', error)
    return NextResponse.json(
      { ok: false, error: 'Erro ao sincronizar agentes', detail: String(error) },
      { status: 500 }
    )
  }
}
