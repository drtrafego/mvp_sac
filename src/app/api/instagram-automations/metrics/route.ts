import { NextRequest, NextResponse } from 'next/server'
import { getCurrentCompany, AuthError, ForbiddenError, forbiddenResponse } from '@/lib/auth'
import { automationMetrics, reportPeriod, ReportParameterError } from '@/lib/instagram-automation-reporting'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest) {
  try {
    const company = await getCurrentCompany()
    if (!company) throw new AuthError('Não autenticado.')
    const result = await automationMetrics(company.id, 'all', reportPeriod(request.nextUrl.searchParams))
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof ReportParameterError) return NextResponse.json({ error: error.message }, { status: 400 })
    if (error instanceof AuthError) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 })
    if (error instanceof ForbiddenError) return forbiddenResponse()
    console.error('[Instagram painel] Falha ao consultar relatório.')
    return NextResponse.json({ error: 'Não foi possível consultar as automações.' }, { status: 500 })
  }
}
