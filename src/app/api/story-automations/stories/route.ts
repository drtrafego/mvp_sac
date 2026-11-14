import { NextResponse } from 'next/server'
import { requireCompany, AuthError } from '@/lib/auth'
import { getInstagramActiveStories } from '@/lib/instagram-stories'

export const dynamic = 'force-dynamic'
export async function GET() {
  try {
    const company = await requireCompany()
    const result = await getInstagramActiveStories(company.id)
    if (!result.ok) return NextResponse.json({ ok: false, stories: [], error: result.error }, { status: result.status, headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json({ ok: true, stories: result.stories }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { if (error instanceof AuthError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 401)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 }); return NextResponse.json({ ok: false, stories: [], error: 'Não foi possível carregar os Stories.' }, { status: 500 }) }
}
