import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { requireCompany, getCurrentUser } from '@/lib/auth'
import { maskSettingsRow, shouldWriteSettingsField } from '@/lib/settings-mask'
import { parseAgentDisplayName } from '@/lib/agent-display-name'

/**
 * Token da barreira de webhooks, devolvido SÓ para admin.
 *
 * Todo webhook exige "?token=<segredo>" na URL, mas a tela mostrava a URL sem
 * ele, então quem copiava dali cadastrava uma URL que morria em 401. O segredo
 * é global, um só para todas as empresas: se aparecesse para o cliente comum,
 * ele poderia forjar webhooks no slug de outro cliente. Por isso vai apenas
 * para o admin, que é quem cadastra os webhooks.
 */
async function webhookTokenParaAdmin(): Promise<string | null> {
  const user = await getCurrentUser()
  if (!user?.isAdmin) return null
  return process.env.RECUPERAVENDAS_WEBHOOK_SECRET ?? null
}

const BOOLEAN_SETTING_KEYS = [
  'hotmartEnabled',
  'greennEnabled',
  'zoutiEnabled',
  'kiwifyEnabled',
] as const

const STRING_SETTING_KEYS = [
  'hotmartWebhookToken',
  'hotmartClientId',
  'hotmartClientSecret',
  'greennWebhookToken',
  'greennPublicKey',
  'greennApiKey',
  'zoutiWebhookToken',
  'zoutiApiKey',
  'kiwifyWebhookToken',
  'whatsappProvider',
  'metaPhoneNumberId',
  'metaAccessToken',
  'metaVerifyToken',
  'metaWabaId',
  'metaAppSecret',
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
  'instagramAppSecret',
] as const

export async function GET(): Promise<NextResponse> {
  const company = await requireCompany()
  const webhookUrlToken = await webhookTokenParaAdmin()
  const [row] = await db.select().from(settings).where(eq(settings.companyId, company.id))

  if (!row) {
    return NextResponse.json({
      companyId: company.id,
      companySlug: company.slug,
      agentDisplayName: company.agentDisplayName ?? '',
      webhookUrlToken,
      hotmartEnabled: true,
      hotmartWebhookToken: '',
      hotmartClientId: '',
      hotmartClientSecret: '',
      greennEnabled: true,
      greennWebhookToken: '',
      greennPublicKey: '',
      greennApiKey: '',
      zoutiEnabled: true,
      zoutiWebhookToken: '',
      zoutiApiKey: '',
      kiwifyEnabled: true,
      kiwifyWebhookToken: '',
      whatsappProvider: 'meta',
      metaPhoneNumberId: '',
      metaAccessToken: '',
      metaVerifyToken: '',
      metaWabaId: '',
      metaAppSecret: '',
      metaAdsAccessToken: '',
      metaAdsAccountId: '',
      metaPixelId: '',
      uazapiBaseUrl: '',
      uazapiInstanceToken: '',
      notificationPhone: '',
      brevoApiKey: '',
      brevoSenderEmail: '',
      brevoSenderName: '',
      instagramUsername: '',
      instagramAccountId: '',
      instagramAccessToken: '',
      instagramVerifyToken: '',
      instagramPageId: '',
      instagramAppSecret: '',
    })
  }

  return NextResponse.json({
    ...maskSettingsRow(row),
    companySlug: company.slug,
    agentDisplayName: company.agentDisplayName ?? '',
    webhookUrlToken,
    metaWabaId: row.metaWabaId ?? '',
    metaAdsAccountId: row.metaAdsAccountId ?? '',
    metaPixelId: row.metaPixelId ?? '',
    brevoSenderEmail: row.brevoSenderEmail ?? '',
    brevoSenderName: row.brevoSenderName ?? '',
    instagramUsername: row.instagramUsername ?? '',
    instagramAccountId: row.instagramAccountId ?? '',
    instagramVerifyToken: row.instagramVerifyToken ?? '',
    instagramPageId: row.instagramPageId ?? '',
    sidebarConfig: row.sidebarConfig ?? null,
  })
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const company = await requireCompany()
  const body = await req.json()
  let agentDisplayName: string | undefined
  try {
    agentDisplayName = parseAgentDisplayName(body.agentDisplayName)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Nome do bot inválido.' },
      { status: 400 },
    )
  }
  const [existing] = await db.select().from(settings).where(eq(settings.companyId, company.id))

  if (agentDisplayName !== undefined) {
    await db
      .update(companies)
      .set({ agentDisplayName, agentDisplayNameManual: true, updatedAt: new Date() })
      .where(eq(companies.id, company.id))
  }

  if (existing) {
    // Cada request grava apenas as colunas que recebeu. Reaproveitar valores do
    // snapshot `existing` para preencher campos ausentes causa lost update
    // quando dois toggles independentes chegam ao mesmo tempo.
    const updateData: Record<string, unknown> = { updatedAt: new Date() }
    for (const key of BOOLEAN_SETTING_KEYS) {
      if (typeof body[key] === 'boolean') updateData[key] = body[key]
    }
    for (const key of STRING_SETTING_KEYS) {
      if (typeof body[key] === 'string' && shouldWriteSettingsField(key, body[key])) {
        updateData[key] = body[key]
      }
    }
    if (body.sidebarConfig !== undefined) updateData.sidebarConfig = body.sidebarConfig

    const [updated] = await db
      .update(settings)
      .set(updateData)
      .where(eq(settings.id, existing.id))
      .returning()
    return NextResponse.json({ ...maskSettingsRow(updated), agentDisplayName: agentDisplayName ?? company.agentDisplayName ?? '' })
  }

  const [created] = await db
    .insert(settings)
    .values({
      companyId: company.id,
      hotmartEnabled: typeof body.hotmartEnabled === 'boolean' ? body.hotmartEnabled : true,
      hotmartWebhookToken: body.hotmartWebhookToken || null,
      hotmartClientId: body.hotmartClientId || null,
      hotmartClientSecret: body.hotmartClientSecret || null,
      greennEnabled: typeof body.greennEnabled === 'boolean' ? body.greennEnabled : true,
      greennWebhookToken: body.greennWebhookToken || null,
      greennPublicKey: body.greennPublicKey || null,
      greennApiKey: body.greennApiKey || null,
      zoutiEnabled: typeof body.zoutiEnabled === 'boolean' ? body.zoutiEnabled : true,
      zoutiWebhookToken: body.zoutiWebhookToken || null,
      zoutiApiKey: body.zoutiApiKey || null,
      kiwifyEnabled: typeof body.kiwifyEnabled === 'boolean' ? body.kiwifyEnabled : true,
      kiwifyWebhookToken: body.kiwifyWebhookToken || null,
      whatsappProvider: body.whatsappProvider || 'meta',
      metaPhoneNumberId: body.metaPhoneNumberId || null,
      metaAccessToken: body.metaAccessToken || null,
      metaVerifyToken: body.metaVerifyToken || null,
      metaWabaId: body.metaWabaId || null,
      metaAppSecret: body.metaAppSecret || null,
      metaAdsAccessToken: body.metaAdsAccessToken || null,
      metaAdsAccountId: body.metaAdsAccountId || null,
      metaPixelId: body.metaPixelId || null,
      uazapiBaseUrl: body.uazapiBaseUrl || null,
      uazapiInstanceToken: body.uazapiInstanceToken || null,
      notificationPhone: body.notificationPhone || null,
      brevoApiKey: body.brevoApiKey || null,
      brevoSenderEmail: body.brevoSenderEmail || null,
      brevoSenderName: body.brevoSenderName || null,
      instagramUsername: body.instagramUsername || null,
      instagramAccountId: body.instagramAccountId || null,
      instagramAccessToken: body.instagramAccessToken || null,
      instagramVerifyToken: body.instagramVerifyToken || null,
      instagramPageId: body.instagramPageId || null,
      instagramAppSecret: body.instagramAppSecret || null,
      sidebarConfig: body.sidebarConfig ?? null,
      updatedAt: new Date(),
    })
    .returning()
  return NextResponse.json({ ...maskSettingsRow(created), agentDisplayName: agentDisplayName ?? company.agentDisplayName ?? '' })
}
