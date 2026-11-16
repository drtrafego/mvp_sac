import { AuthError, ForbiddenError } from '@/lib/auth'
import { isOperatorTableMissing, OperatorAccessError, requireOperatorAdmin } from '@/lib/operator/panel-auth'
import { executorStatus } from '@/lib/operator/executor/status'
import { executorResponse } from '@/lib/operator/executor/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET() {
  try {
    const actor = await requireOperatorAdmin()
    return executorResponse(await executorStatus(actor.company.id))
  } catch (error) {
    const redirect = typeof error === 'object' && error !== null && 'digest' in error && String(error.digest).startsWith('NEXT_REDIRECT')
    const status = error instanceof OperatorAccessError ? error.status : error instanceof AuthError || redirect ? 401 : error instanceof ForbiddenError || isOperatorTableMissing(error) ? 403 : 500
    return executorResponse({ codigo: 'EXECUTOR_UNAVAILABLE' }, status)
  }
}
