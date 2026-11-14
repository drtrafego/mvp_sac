import { NextResponse } from 'next/server'
import { z } from 'zod'
import { AuthError, ForbiddenError } from '@/lib/auth'
import { isOperatorTableMissing, OperatorAccessError, requireOperatorAdmin } from '../panel-auth'
import { OperatorServiceError } from '../service'
import { operatorRateLimit } from '../rate-limit'
import { expireWaitingJobs } from './flow'
import type { Ator } from './types'
export function assertSameOrigin(request: Request) {
  const origin = request.headers.get('origin')
  const url = new URL(request.url)
  const allowed = [url.origin]
  // O proxy deve sobrescrever esses headers. Confirmar o host no preview Vercel.
  const protocol = request.headers.get('x-forwarded-proto')?.split(',')[0].trim() ?? url.protocol.slice(0, -1)
  for (const header of ['x-forwarded-host', 'host']) {
    const host = request.headers.get(header)?.split(',')[0].trim()
    if (host && /^(https|http)$/.test(protocol) && /^[a-z0-9.[\]:-]+$/i.test(host)) {
      try { allowed.push(new URL(`${protocol}://${host}`).origin) } catch { /* Host inválido não é permitido. */ }
    }
  }
  if (process.env.NEXT_PUBLIC_APP_URL) allowed.push(new URL(process.env.NEXT_PUBLIC_APP_URL).origin)
  if (!origin || !allowed.includes(origin) || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new OperatorAccessError('Origem ou conteúdo do pedido inválido.', 403)
}
export function response(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } }) }
export function errorResponse(error: unknown) {
  if (error instanceof OperatorAccessError) return response({ error: error.message, code: 'ACCESS_DENIED' }, error.status)
  if (error instanceof AuthError) return response({ error: 'Sem permissão.', code: 'UNAUTHENTICATED' }, 401)
  if (error instanceof ForbiddenError) return response({ error: 'Sem permissão.', code: 'FORBIDDEN' }, 403)
  if (error instanceof OperatorServiceError) return response({ error: error.message, code: error.code }, error.status)
  if (error instanceof z.ZodError) return response({ error: 'Pedido inválido.', code: 'INVALID_BODY' }, 400)
  if (isOperatorTableMissing(error)) return response({ error: 'Operador desligado para esta empresa.', code: 'DISABLED' }, 403)
  if (error && typeof error === 'object' && 'digest' in error && String(error.digest).startsWith('NEXT_REDIRECT')) return response({ error: 'Sem sessão.', code: 'UNAUTHENTICATED' }, 401)
  return response({ error: 'Falha no Operador SAC.', code: 'OPERATOR_ERROR' }, 500)
}
export async function routeActor(request: Request, id: string, route: string): Promise<Ator> {
  const actor = await requireOperatorAdmin()
  if (request.method !== 'GET') assertSameOrigin(request)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new OperatorServiceError('Recurso não encontrado.', 404, 'NOT_FOUND')
  if (request.method !== 'GET' && !operatorRateLimit(`${actor.company.id}:${actor.user.id}:${route}`, 20)) throw new OperatorServiceError('Muitas solicitações. Tente em um minuto.', 429, 'RATE_LIMIT')
  await expireWaitingJobs(actor.company.id)
  return { companyId: actor.company.id, userId: actor.user.id, role: actor.role, actorName: actor.user.displayName ?? 'Admin', companySlug: actor.company.slug }
}
export const choiceSchema = z.object({ actionId: z.string().uuid(), leadId: z.number().int().positive().optional(), etapaId: z.string().min(1).max(128).optional(), ruleId: z.number().int().positive().optional(), lembrarApelido: z.boolean().optional() }).strict()
  .refine(v => [v.leadId, v.etapaId, v.ruleId].filter(v => v !== undefined).length === 1, 'Escolha uma opção.')
export const emptyBodySchema = z.object({}).strict()
