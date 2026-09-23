export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireCompany } from '@/lib/auth'
import { decodeInboxCursor, INBOX_PAGE_SIZE, loadInboxPage } from '@/lib/inbox-conversations'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const { searchParams } = new URL(req.url)

  const cursor = searchParams.get('cursor')
  if (cursor && !decodeInboxCursor(cursor)) {
    return NextResponse.json({ error: 'Cursor inválido.' }, { status: 400 })
  }

  const requestedLimit = Number(searchParams.get('limit') || INBOX_PAGE_SIZE)
  const page = await loadInboxPage({
    companyId: company.id,
    channel: searchParams.get('channel'),
    source: searchParams.get('source'),
    status: searchParams.get('status'),
    query: searchParams.get('q'),
    cursor,
    limit: Number.isFinite(requestedLimit) ? requestedLimit : INBOX_PAGE_SIZE,
  })

  return NextResponse.json(page)
}
