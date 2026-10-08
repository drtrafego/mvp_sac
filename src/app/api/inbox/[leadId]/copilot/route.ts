export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { requireCompany, requireSacActor } from '@/lib/auth'
import { generateCopilotDraft } from '@/lib/copilot'

type Params = { params: Promise<{ leadId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = parseInt(leadId)
  if (isNaN(id) || id <= 0) {
    return NextResponse.json({ error: 'ID de lead inválido' }, { status: 400 })
  }

  const company = await requireCompany()
  await requireSacActor()

  let operatorDraft = ''
  try {
    const body = await req.json()
    if (body && typeof body.operatorDraft === 'string') {
      operatorDraft = body.operatorDraft
    }
  } catch {
    // Body opcional
  }

  try {
    const result = await generateCopilotDraft({
      companyId: company.id,
      leadId: id,
      operatorDraft,
    })

    return NextResponse.json({
      ok: true,
      ...result,
    })
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message || 'Falha ao gerar sugestão do Copiloto.' },
      { status: 500 }
    )
  }
}
