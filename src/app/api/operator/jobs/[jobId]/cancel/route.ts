import { cancelJob } from '@/lib/operator/acoes/flow'
import { routeActor, response, errorResponse, emptyBodySchema } from '@/lib/operator/acoes/csrf'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params
    const ator = await routeActor(request, jobId, 'cancel')
    emptyBodySchema.parse(await request.json().catch(() => null))
    return response(await cancelJob(ator, jobId))
  } catch (error) { return errorResponse(error) }
}
