import { NextRequest, NextResponse } from 'next/server'
import { requireCompany } from '@/lib/auth'
import { FollowupStep, FollowupWindow, FollowupSpacing } from '@/lib/followup'
import {
  getFollowupConfigReal,
  saveFollowupConfigReal,
  getFollowupSentStatsReal,
} from '@/lib/followup-server'

export async function GET(req: NextRequest) {
  try {
    const company = await requireCompany()
    const { config, agentSlug, isSharedDbConnected } = await getFollowupConfigReal(company.slug, company.id)
    const stats = await getFollowupSentStatsReal(company.slug, company.id)

    return NextResponse.json({
      ok: true,
      config,
      stats,
      agentSlug,
      companySlug: company.slug,
      isSharedDbConnected,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 401 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const company = await requireCompany()
    const body = (await req.json()) as {
      enabled?: boolean
      steps?: FollowupStep[]
      window?: FollowupWindow
      spacing?: FollowupSpacing
      stepsByOrigin?: { ad?: FollowupStep[] }
    }

    if (body.enabled === undefined || !Array.isArray(body.steps)) {
      return NextResponse.json({ error: 'Parâmetros inválidos' }, { status: 400 })
    }

    const res = await saveFollowupConfigReal(company.slug, company.id, {
      // Normalizado aqui, não só em saveFollowupConfigReal: `body` vem de
      // JSON não validado (o `as` acima é só tipo, não runtime), então
      // qualquer valor não-booleano (string "true"/"false", número) tem que
      // virar `false` por padrão — nunca ligar follow-up por coerção.
      enabled: body.enabled === true,
      steps: body.steps,
      window: body.window,
      spacing: body.spacing,
      stepsByOrigin: body.stepsByOrigin,
    })

    if (!res.ok) {
      return NextResponse.json({ error: res.message || 'Erro ao salvar' }, { status: 400 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
