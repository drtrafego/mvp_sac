import { NextRequest, NextResponse } from 'next/server'
import { authenticateReport, reportError } from '@/lib/instagram-automation-report-auth'
import { automationMetrics, reportPeriod, reportType } from '@/lib/instagram-automation-reporting'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest, { params }: { params: Promise<{ idOrSlug: string }> }) {
  try {
    const { idOrSlug } = await params
    const { context, error } = await authenticateReport(request, idOrSlug)
    if (error) return error
    if (!context) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 })
    const query = request.nextUrl.searchParams
    const type = reportType(query.get('type') ?? 'all')
    const period = reportPeriod(query)
    return NextResponse.json({ ok: true, ...await automationMetrics(context.company.id, type, period) }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) { return reportError(error) }
}
