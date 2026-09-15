export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq } from 'drizzle-orm'

type Params = { params: Promise<{ idOrSlug: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.companyId, context.company.id))

  return NextResponse.json({
    ok: true,
    company: { id: context.company.id, slug: context.company.slug, name: context.company.name },
    settings: row || null,
  })
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  try {
    const body = await req.json()
    const allowedKeys = [
      'whatsappProvider',
      'metaPhoneNumberId',
      'metaAccessToken',
      'metaVerifyToken',
      'metaWabaId',
      'uazapiBaseUrl',
      'uazapiInstanceToken',
      'notificationPhone',
      'brevoApiKey',
      'brevoSenderEmail',
      'brevoSenderName',
      'instagramUsername',
      'instagramAccountId',
      'instagramAccessToken',
      'instagramVerifyToken',
      'instagramPageId',
      'supabaseDatabaseUrl',
      'hotmartWebhookToken',
      'kiwifyWebhookToken',
      'greennWebhookToken',
      'zoutiWebhookToken',
    ]

    const updateData: Record<string, any> = { updatedAt: new Date() }
    for (const k of allowedKeys) {
      if (body[k] !== undefined) updateData[k] = body[k]
    }

    // Upsert em settings
    const [existing] = await db.select().from(settings).where(eq(settings.companyId, context.company.id))
    if (!existing) {
      await db.insert(settings).values({ companyId: context.company.id, ...updateData })
    } else {
      await db.update(settings).set(updateData).where(eq(settings.companyId, context.company.id))
    }

    const [updated] = await db.select().from(settings).where(eq(settings.companyId, context.company.id))
    return NextResponse.json({ ok: true, settings: updated })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Erro ao atualizar configurações' }, { status: 500 })
  }
}
