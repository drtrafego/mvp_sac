export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sacPendingItems } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { requireCompany } from '@/lib/auth'

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
    const itemId = parseInt(id)
    if (isNaN(itemId)) return noStoreJson({ error: 'ID inválido' }, { status: 400 })

    const company = await requireCompany()

    const body = (await req.json().catch(() => null)) as Record<string, any> | null
    if (!body || typeof body !== 'object') {
      return noStoreJson({ error: 'Corpo da requisição inválido' }, { status: 400 })
    }

    const state = body.state ? String(body.state).trim() : 'resolvido'

    const [updated] = await db
      .update(sacPendingItems)
      .set({
        state,
        resolvedAt: state === 'resolvido' || state === 'descartado' ? new Date() : null,
      })
      .where(and(eq(sacPendingItems.id, itemId), eq(sacPendingItems.companyId, company.id)))
      .returning()

    if (!updated) {
      return noStoreJson({ error: 'Item de pendência não encontrado' }, { status: 404 })
    }

    return noStoreJson({ success: true, item: updated })
  } catch (err: any) {
    return noStoreJson({ error: err.message || 'Erro ao atualizar pendência' }, { status: 500 })
  }
}
