export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'
import { requireCompanyRole, AuthError, ForbiddenError } from '@/lib/auth'
import { parsePositiveId, SacInputError } from '@/lib/sac-access'
import { sacSqlRows } from '@/lib/sac-pending-rules'

function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const { id } = await params
    const itemId = parsePositiveId(id)

    const { company, user } = await requireCompanyRole('membro')

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return noStoreJson({ error: 'Corpo da requisição inválido' }, { status: 400 })
    }

    const state = body.state === undefined ? 'resolvido' : body.state
    if (typeof state !== 'string' || !['pendente', 'em_atendimento', 'resolvido', 'descartado'].includes(state)) {
      return noStoreJson({ error: 'Estado de pendência inválido' }, { status: 400 })
    }

    const [updated] = sacSqlRows(await db.execute(sql`
      WITH updated AS (
        UPDATE sac_pending_items SET state = ${state},
          resolved_at = CASE WHEN ${state} IN ('resolvido', 'descartado') THEN NOW() ELSE NULL END
        WHERE id = ${itemId} AND company_id = ${company.id}
        RETURNING *
      ), audited AS (
        INSERT INTO sac_audit_events (company_id, lead_id, type, actor_type, actor_id, actor_name, reference_type, reference_id, payload)
        SELECT company_id, lead_id, 'pending_rule_updated', 'human', ${user.id},
          ${user.displayName || user.primaryEmail || 'Atendente'}, 'pending_item', id::text,
          jsonb_build_object('state', ${state}::text) FROM updated
        RETURNING id
      )
      SELECT id, company_id AS "companyId", lead_id AS "leadId", rule_type AS "ruleType", source_key AS "sourceKey", reason,
        human_owner_member_id AS "humanOwnerMemberId", due_at AS "dueAt", state,
        created_at AS "createdAt", resolved_at AS "resolvedAt" FROM updated
    `))

    if (!updated) {
      return noStoreJson({ error: 'Item de pendência não encontrado' }, { status: 404 })
    }

    return noStoreJson({ success: true, item: updated })
  } catch (err: unknown) {
    return noStoreJson({ error: err instanceof Error ? err.message : 'Erro ao atualizar pendência' }, { status: err instanceof AuthError || err instanceof ForbiddenError || err instanceof SacInputError ? err.status : 500 })
  }
}
