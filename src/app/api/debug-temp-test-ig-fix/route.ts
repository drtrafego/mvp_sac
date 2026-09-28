// ROTA DE DEBUG TEMPORARIA — 28/09/2026, testa o fix do host errado
// chamando fetchInstagramUserProfile de verdade (GET, sem efeito colateral)
// pro lead real que estava falhando. REMOVER depois.
import { NextRequest, NextResponse } from 'next/server'
import { fetchInstagramUserProfile } from '@/lib/instagram'

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== 'test-ig-fix-28set-temp') {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const igsid = req.nextUrl.searchParams.get('igsid') || '5539503362785009'
  const result = await fetchInstagramUserProfile({ igsid, companyId: 292 })

  return NextResponse.json(result)
}
