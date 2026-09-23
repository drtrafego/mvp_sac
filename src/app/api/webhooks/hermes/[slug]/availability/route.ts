export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { checkHermesWebhookToken } from '@/lib/webhook-auth'
import { isNativeAvailabilityCompany } from '@/lib/agenda-schedule'
import { parseNativeAvailabilityPayload, upsertNativeAvailabilitySnapshot } from '@/lib/native-availability'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const auth = checkHermesWebhookToken(req)
  if (!auth.ok) return NextResponse.json({ error: auth.reason }, { status: auth.status })

  const { slug } = await params
  if (!isNativeAvailabilityCompany(slug)) {
    return NextResponse.json({ error: 'Empresa sem fonte nativa de horário.' }, { status: 404 })
  }

  const body = await req.json().catch(() => null)
  const parsed = parseNativeAvailabilityPayload(slug, body)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

  try {
    const snapshot = await upsertNativeAvailabilitySnapshot(slug, parsed.value)
    return NextResponse.json({
      ok: true,
      source: snapshot.source,
      cursor: snapshot.sourceCursor,
      capturedAt: snapshot.capturedAt.toISOString(),
      syncedAt: snapshot.syncedAt.toISOString(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message === 'Empresa não encontrada' ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
}
