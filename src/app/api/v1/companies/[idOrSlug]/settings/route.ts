export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, settings } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq } from 'drizzle-orm'
import { mask } from '@/lib/settings-mask'
import { parseAgentDisplayName } from '@/lib/agent-display-name'

type Params = { params: Promise<{ idOrSlug: string }> }

const WHATSAPP_SEM_SECRET_WARNING = 'WhatsApp configurado sem App Secret próprio: mensagens desta empresa vão falhar em silêncio se o secret compartilhado também não existir. Configure o App Secret do app desta empresa na Meta for Developers.'

function hasFilledValue(value: unknown): boolean {
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value)
}

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
    company: {
      id: context.company.id,
      slug: context.company.slug,
      name: context.company.name,
      agentDisplayName: context.company.agentDisplayName ?? '',
    },
    settings: maskedSettings,
  })
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { idOrSlug } = await params
  const { error, context } = await authenticateAgentRequest(req, idOrSlug)
  if (error || !context) return error!

  const body = await req.json()
  let agentDisplayName: string | undefined
  try {
    agentDisplayName = parseAgentDisplayName(body.agentDisplayName)
  } catch (validationError) {
    return NextResponse.json(
      { error: validationError instanceof Error ? validationError.message : 'Nome do bot inválido.' },
      { status: 400 },
    )
  }

  try {
    const allowedKeys = [
      'whatsappProvider',
      'metaPhoneNumberId',
      'metaAccessToken',
      'metaVerifyToken',
      'metaWabaId',
      'metaAdsAccessToken',
      'metaAdsAccountId',
      'metaPixelId',
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

    if (agentDisplayName !== undefined) {
      await db
        .update(companies)
        .set({ agentDisplayName, agentDisplayNameManual: true, updatedAt: new Date() })
        .where(eq(companies.id, context.company.id))
    }

    // Upsert em settings
    const [existing] = await db.select().from(settings).where(eq(settings.companyId, context.company.id))
    if (!existing) {
      await db.insert(settings).values({ companyId: context.company.id, ...updateData })
    } else {
      await db.update(settings).set(updateData).where(eq(settings.companyId, context.company.id))
    }

    const [updated] = await db.select().from(settings).where(eq(settings.companyId, context.company.id))
    const warnings = body.metaPhoneNumberId !== undefined && hasFilledValue(body.metaPhoneNumberId) && !hasFilledValue(updated?.metaAppSecret)
      ? [WHATSAPP_SEM_SECRET_WARNING]
      : []

    return NextResponse.json({
      ok: true,
      company: {
        id: context.company.id,
        slug: context.company.slug,
        name: context.company.name,
        agentDisplayName: agentDisplayName ?? context.company.agentDisplayName ?? '',
      },
      settings: updated,
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || 'Erro ao atualizar configurações' }, { status: 500 })
  }
}
