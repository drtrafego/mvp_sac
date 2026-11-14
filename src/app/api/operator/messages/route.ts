import { assertSameOrigin } from '@/lib/operator/acoes/csrf'
import { createHash } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { AuthError, ForbiddenError } from '@/lib/auth'
import { db } from '@/lib/db'
import { isOperatorTableMissing, OperatorAccessError, requireOperatorAdmin } from '@/lib/operator/panel-auth'
import { operatorRateLimit } from '@/lib/operator/rate-limit'
import { createOperatorService, OperatorServiceError } from '@/lib/operator/service'
import { sacOperatorJobs } from '@/lib/operator/schema'

export const maxDuration = 30
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const MAX_TEXT = 4000

function response(body: unknown, status = 200) { return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } }) }
function errorResponse(error: unknown) {
  if (error instanceof OperatorAccessError) return response({ error: error.message }, error.status)
  if (error instanceof AuthError) return response({ error: 'Sem permissão.' }, 401)
  if (error instanceof ForbiddenError) return response({ error: 'Sem permissão.' }, 403)
  if (error instanceof OperatorServiceError) return response({ error: error.message, code: error.code }, error.status)
  if (isOperatorTableMissing(error)) return response({ error: 'Operador desligado para esta empresa.' }, 403)
  if (typeof error === 'object' && error !== null && 'digest' in error && String((error as { digest?: unknown }).digest).startsWith('NEXT_REDIRECT')) return response({ error: 'Sem sessão.' }, 401)
  console.error('[Operador SAC] falha na rota de mensagens', { kind: error instanceof Error ? error.name : 'desconhecido' })
  return response({ error: 'Falha no Operador SAC.' }, 500)
}

export async function GET() {
  try {
    const actor = await requireOperatorAdmin()
    await createOperatorService().expireStuck(actor.company.id)
    const jobs = await db.select().from(sacOperatorJobs).where(eq(sacOperatorJobs.companyId, actor.company.id)).orderBy(desc(sacOperatorJobs.createdAt)).limit(50)
    return response({ jobs })
  } catch (error) { return errorResponse(error) }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await requireOperatorAdmin()
    assertSameOrigin(request)
    if (!operatorRateLimit(`${actor.company.id}:${actor.user.id}`)) return response({ error: 'Muitas solicitações. Tente novamente em um minuto.' }, 429)
    const body = await request.json().catch(() => null) as { text?: unknown; idempotencyKey?: unknown } | null
    if (body && Object.keys(body).some(k => !['text', 'idempotencyKey'].includes(k))) return response({ error: 'Pedido inválido.', code: 'INVALID_BODY' }, 400)
    if (!body || typeof body.text !== 'string') return response({ error: 'Informe o pedido em texto.' }, 400)
    const text = body.text.trim()
    if (!text || text.length > MAX_TEXT) return response({ error: `O pedido deve ter até ${MAX_TEXT} caracteres.` }, 400)
    const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.length <= 200 && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : createHash('sha256').update(`${actor.company.id}:${actor.user.id}:${text}:${Math.floor(Date.now() / 60_000)}`).digest('hex')
    const outcome = await createOperatorService().submit({ companyId: actor.company.id, userId: actor.user.id, role: actor.role, requestText: text, idempotencyKey, actorName: actor.user.displayName ?? 'Admin', companySlug: actor.company.slug })
    return response({ job: outcome.job, reused: outcome.reused }, outcome.reused ? 200 : 202)
  } catch (error) { return errorResponse(error) }
}
