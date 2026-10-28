import { NextResponse } from 'next/server'
import { getCompanyAccess } from '@/lib/auth'
import { runHealthChecks } from '@/lib/health/service'

export const dynamic = 'force-dynamic'

/**
 * Leitura autenticada da saúde da empresa atual. O polling dispara apenas
 * leituras locais e GETs seguros dos endpoints já configurados. Nenhum canal
 * de cliente é usado pela checagem.
 */
export async function GET() {
  try {
    const { company } = await getCompanyAccess()
    const data = await runHealthChecks(company.id)
    return NextResponse.json({
      ok: true,
      company: { id: company.id, name: company.name, slug: company.slug },
      checkedAt: new Date().toISOString(),
      ...data,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Não foi possível verificar a saúde do SAC.'
    return NextResponse.json({ ok: false, error: message }, { status: message.includes('autentic') ? 401 : 500 })
  }
}
