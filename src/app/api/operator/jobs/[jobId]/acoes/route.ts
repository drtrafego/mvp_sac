import { jobView } from '@/lib/operator/acoes/flow'
import { routeActor, response, errorResponse } from '@/lib/operator/acoes/csrf'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params
    const ator = await routeActor(request, jobId, 'acoes')
    return response(await jobView(ator, jobId))
  } catch (error) { return errorResponse(error) }
}
