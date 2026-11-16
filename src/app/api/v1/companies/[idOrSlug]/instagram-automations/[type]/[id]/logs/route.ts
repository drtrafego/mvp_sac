import { NextRequest, NextResponse } from 'next/server'
import { authenticateReport, reportError } from '@/lib/instagram-automation-report-auth'
import { automationLogs, positiveInteger, reportPeriod, reportType, ReportParameterError } from '@/lib/instagram-automation-reporting'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ idOrSlug: string; type: string; id: string }> }) {
  try {
    const { idOrSlug, type: rawType, id: rawId } = await params
    const { context, error } = await authenticateReport(request, idOrSlug)
    if (error) return error
    if (!context) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 })
    const type = reportType(rawType)
    if (type === 'all') throw new ReportParameterError('type deve ser comment ou story no histórico.')
    const id = positiveInteger(rawId, 'id')
    const query = request.nextUrl.searchParams
    const period = reportPeriod(query)
    const page = positiveInteger(query.get('page') ?? '1', 'page')
    const limit = positiveInteger(query.get('limit') ?? '50', 'limit', 200)
    const result = await automationLogs(context.company.id, type, id, period, page, limit)
    if (!result) return NextResponse.json({ error: 'Automação não encontrada.' }, { status: 404 })
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return reportError(error) }
}
