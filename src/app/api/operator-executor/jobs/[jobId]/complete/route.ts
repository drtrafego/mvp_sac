import { authenticateExecutor, executorBody, executorError, executorResponse, leaseHeader } from '@/lib/operator/executor/auth'
import { completeBodySchema } from '@/lib/operator/executor/contract'
import { jobScope, completar } from '@/lib/operator/executor/queue'

export const maxDuration = 30
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const executor = await authenticateExecutor(request)
    const { jobId } = await context.params
    const companyId = await jobScope(executor, jobId)
    const body = await executorBody(request, completeBodySchema)
    const lease = { executor, jobId, companyId, epoch: body.epoch, token: leaseHeader(request) }
    return executorResponse(await completar(lease, body))
  } catch (error) { return executorError(error) }
}
