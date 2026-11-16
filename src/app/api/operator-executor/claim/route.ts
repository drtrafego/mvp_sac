import { authenticateExecutor, executorBody, executorError, executorResponse } from '@/lib/operator/executor/auth'
import { claimBodySchema } from '@/lib/operator/executor/contract'
import { reclamar } from '@/lib/operator/executor/queue'

export const maxDuration = 30
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request) {
  try {
    const executor = await authenticateExecutor(request)
    const body = await executorBody(request, claimBodySchema)
    const deadline = Date.now() + 25000
    let lastWorkAt = Date.now()
    do {
      const job = await reclamar(executor, body, since => { lastWorkAt = since })
      if (job) return executorResponse(job)
      const interval = Date.now() - lastWorkAt < 60_000 ? 2000 : 4500 + Math.floor(Math.random() * 1000)
      if (body.estado === 'pausado' || request.signal.aborted || Date.now() + interval >= deadline) break
      await new Promise(resolve => setTimeout(resolve, interval))
    } while (Date.now() < deadline)
    return executorResponse(null, 204)
  } catch (error) { return executorError(error) }
}
