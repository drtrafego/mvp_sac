import { NextResponse } from 'next/server'
import { getInstagramRecentMedia } from '@/lib/instagram'
import { requireCompany, AuthError } from '@/lib/auth'

export async function GET() {
  try {
    const company = await requireCompany()
    const result = await getInstagramRecentMedia(company.id, 30)

    if (!result.ok) {
      return NextResponse.json({
        ok: false,
        media: [],
        error: result.error || 'Não foi possível carregar os posts do Instagram.',
      })
    }

    return NextResponse.json({ ok: true, media: result.media })
  } catch (err: any) {
    if (err instanceof AuthError || err?.status === 401) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    console.error('[Comment Automations Media GET Error]:', err)
    return NextResponse.json({ error: 'Erro ao carregar mídias do Instagram' }, { status: 500 })
  }
}
