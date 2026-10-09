export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, requireCompanyRole, AuthError, ForbiddenError } from '@/lib/auth'
import { AttentionInputError, loadSacAttention, parseAttentionQuery } from '@/lib/sac-attention'
import { evaluateSacPendingRules } from '@/lib/sac-pending-rules'

function noStoreJson(body: unknown, status = 200): NextResponse {
  const response = NextResponse.json(body, { status })
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    // requireCompany redirects browser pages; the API instead returns JSON 401.
    if (!await getCurrentUser()) throw new AuthError('Não autenticado')
    const { company, user } = await requireCompanyRole('membro')
    const query = parseAttentionQuery(new URL(req.url).searchParams)
    const now = new Date()
    // Share the existing reconciliation/cron lifecycle. Acknowledging an alert
    // does not erase an outstanding action or recreate the same alert episode.
    await evaluateSacPendingRules({ companyId: company.id, now })
    return noStoreJson(await loadSacAttention({ companyId: company.id, userId: user.id, ...query, now }))
  } catch (error: unknown) {
    if (error instanceof AuthError || error instanceof ForbiddenError || error instanceof AttentionInputError) {
      return noStoreJson({ error: error.message }, error.status)
    }
    console.error('[SAC attention] Failed to load work queue', error instanceof Error ? error.name : 'unknown')
    return noStoreJson({ error: 'Não foi possível carregar a fila de atendimento.' }, 500)
  }
}
