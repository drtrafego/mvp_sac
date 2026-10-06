export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'

import { requireCompany } from '@/lib/auth'
import { decodeInboxCursor, INBOX_PAGE_SIZE, loadInboxPage } from '@/lib/inbox-conversations'
function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  response.headers.set('Surrogate-Control', 'no-store')
  return response
}


export async function GET(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const { searchParams } = new URL(req.url)

  const cursor = searchParams.get('cursor')
  if (cursor && !decodeInboxCursor(cursor)) {
    return noStoreJson({ error: 'Cursor inválido.' }, { status: 400 })
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

  return noStoreJson(page)
}
