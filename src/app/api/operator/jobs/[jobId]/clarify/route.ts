import { clarifyJob } from '@/lib/operator/acoes/flow'
import { routeActor, response, errorResponse, choiceSchema } from '@/lib/operator/acoes/csrf'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params
    const ator = await routeActor(request, jobId, 'clarify')
    return response(await clarifyJob(ator, jobId, choiceSchema.parse(await request.json().catch(() => null))))
  } catch (error) { return errorResponse(error) }
}
