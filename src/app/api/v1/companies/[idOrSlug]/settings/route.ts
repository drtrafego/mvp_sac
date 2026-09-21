export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq } from 'drizzle-orm'
import { mask } from '@/lib/settings-mask'

type Params = { params: Promise<{ idOrSlug: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const [row] = await db
    .select()
    .from(settings)
    .where(eq(settings.companyId, context.company.id))

  // Mesmo padrão de mask() de src/app/api/settings/route.ts (painel humano):
  // token/segredo nunca sai em texto plano numa resposta GET, nem pra agente
  // autenticado. Sem isso, qualquer chamada a esta rota devolvia
  // metaAdsAccessToken (e os demais segredos) em claro.
  const maskedSettings = row
    ? {
        ...row,
        hotmartWebhookToken: mask(row.hotmartWebhookToken),
        hotmartClientSecret: mask(row.hotmartClientSecret),
        greennWebhookToken: mask(row.greennWebhookToken),
        greennApiKey: mask(row.greennApiKey),
        zoutiWebhookToken: mask(row.zoutiWebhookToken),
        zoutiApiKey: mask(row.zoutiApiKey),
        kiwifyWebhookToken: mask(row.kiwifyWebhookToken),
        metaAccessToken: mask(row.metaAccessToken),
        metaAppSecret: mask(row.metaAppSecret),
        metaAdsAccessToken: mask(row.metaAdsAccessToken),
        uazapiInstanceToken: mask(row.uazapiInstanceToken),
        brevoApiKey: mask(row.brevoApiKey),
        instagramAccessToken: mask(row.instagramAccessToken),
      }
    : null

  return NextResponse.json({
    ok: true,
    company: { id: context.company.id, slug: context.company.slug, name: context.company.name },
    settings: maskedSettings,
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
      'metaAdsAccessToken',
      'metaAdsAccountId',
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
      'agentBiaApiKey',
      'agentLuanaApiKey',
      'agentRenatoApiKey',
      'allowedIps',
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
