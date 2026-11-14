import { z } from 'zod'
import { confirmJob } from '@/lib/operator/acoes/flow'
import { routeActor, response, errorResponse } from '@/lib/operator/acoes/csrf'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const bodySchema = z.object({ planHash: z.string().regex(/^[0-9a-f]{64}$/), codigo: z.string().trim().min(1).max(80) }).strict()
export async function POST(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params
    const ator = await routeActor(request, jobId, 'confirm')
    return response(await confirmJob(ator, jobId, bodySchema.parse(await request.json().catch(() => null))))
  } catch (error) { return errorResponse(error) }
}
