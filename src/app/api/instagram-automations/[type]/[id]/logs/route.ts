import { NextRequest, NextResponse } from 'next/server'
import { getCurrentCompany, AuthError, ForbiddenError, forbiddenResponse } from '@/lib/auth'
import { automationLogs, reportPeriod, reportType, positiveInteger, ReportParameterError } from '@/lib/instagram-automation-reporting'

export const dynamic = 'force-dynamic'
export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string; id: string }> }) {
  try {
    const company = await getCurrentCompany()
    if (!company) throw new AuthError('Não autenticado.')
    const { type: rawType, id: rawId } = await params
    const type = reportType(rawType)
    if (type === 'all') throw new ReportParameterError('Informe comentário ou Story para consultar o histórico.')
    const id = positiveInteger(rawId, 'id')
    const query = request.nextUrl.searchParams
    const page = positiveInteger(query.get('page') ?? '1', 'page')
    const limit = positiveInteger(query.get('limit') ?? '10', 'limit', 200)
    const result = await automationLogs(company.id, type, id, reportPeriod(query), page, limit)
    if (!result) return NextResponse.json({ error: 'Automação não encontrada.' }, { status: 404 })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof ReportParameterError) return NextResponse.json({ error: error.message }, { status: 400 })
    if (error instanceof AuthError) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 })
    if (error instanceof ForbiddenError) return forbiddenResponse()
    console.error('[Instagram painel] Falha ao consultar relatório.')
    return NextResponse.json({ error: 'Não foi possível consultar as automações.' }, { status: 500 })
  }
}
