import { desfazerAcao } from '@/lib/operator/acoes/undo'
import { routeActor, response, errorResponse, emptyBodySchema } from '@/lib/operator/acoes/csrf'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, context: { params: Promise<{ actionId: string }> }) {
  try {
    const { actionId } = await context.params
    const ator = await routeActor(request, actionId, 'undo')
    emptyBodySchema.parse(await request.json().catch(() => null))
    const result = await desfazerAcao(ator, actionId)
    return response(result, result.reused ? 200 : 202)
  } catch (error) { return errorResponse(error) }
}
