import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { requireCompany, getCurrentUser } from '@/lib/auth'
import { mask } from '@/lib/settings-mask'

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

function resolveSecret(bodyVal: string | undefined, existingVal: string | null | undefined): string | null {
  if (!bodyVal) return existingVal ?? null
  if (bodyVal.startsWith('****')) return existingVal ?? null
  return bodyVal
}

const AGENT_DISPLAY_NAME_MAX_LENGTH = 80

function parseAgentDisplayName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error('O nome do bot deve ser um texto.')

  const trimmed = value.trim()
  if (!trimmed) throw new Error('O nome do bot não pode ficar vazio.')
  if (trimmed.length > AGENT_DISPLAY_NAME_MAX_LENGTH) {
    throw new Error(`O nome do bot deve ter no máximo ${AGENT_DISPLAY_NAME_MAX_LENGTH} caracteres.`)
  }
  return trimmed
}

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
      hotmartWebhookToken: '',
      hotmartClientId: '',
      hotmartClientSecret: '',
      greennWebhookToken: '',
      greennPublicKey: '',
      greennApiKey: '',
      zoutiWebhookToken: '',
      zoutiApiKey: '',
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
    })
  }

  return NextResponse.json({
    ...row,
    companySlug: company.slug,
    agentDisplayName: company.agentDisplayName ?? '',
    webhookUrlToken,
    hotmartWebhookToken: mask(row.hotmartWebhookToken),
    hotmartClientSecret: mask(row.hotmartClientSecret),
    greennWebhookToken: mask(row.greennWebhookToken),
    greennApiKey: mask(row.greennApiKey),
    zoutiWebhookToken: mask(row.zoutiWebhookToken),
    zoutiApiKey: mask(row.zoutiApiKey),
    kiwifyWebhookToken: mask(row.kiwifyWebhookToken),
    metaAccessToken: mask(row.metaAccessToken),
    metaWabaId: row.metaWabaId ?? '',
    metaAppSecret: mask(row.metaAppSecret),
    metaAdsAccessToken: mask(row.metaAdsAccessToken),
    metaAdsAccountId: row.metaAdsAccountId ?? '',
    metaPixelId: row.metaPixelId ?? '',
    uazapiInstanceToken: mask(row.uazapiInstanceToken),
    brevoApiKey: mask(row.brevoApiKey),
    brevoSenderEmail: row.brevoSenderEmail ?? '',
    brevoSenderName: row.brevoSenderName ?? '',
    instagramUsername: row.instagramUsername ?? '',
    instagramAccountId: row.instagramAccountId ?? '',
    instagramAccessToken: mask(row.instagramAccessToken),
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
    const [updated] = await db
      .update(settings)
      .set({
        hotmartWebhookToken: resolveSecret(body.hotmartWebhookToken, existing.hotmartWebhookToken),
        hotmartClientId: body.hotmartClientId ?? existing.hotmartClientId,
        hotmartClientSecret: resolveSecret(body.hotmartClientSecret, existing.hotmartClientSecret),
        greennWebhookToken: resolveSecret(body.greennWebhookToken, existing.greennWebhookToken),
        greennPublicKey: body.greennPublicKey ?? existing.greennPublicKey,
        greennApiKey: resolveSecret(body.greennApiKey, existing.greennApiKey),
        zoutiWebhookToken: resolveSecret(body.zoutiWebhookToken, existing.zoutiWebhookToken),
        zoutiApiKey: resolveSecret(body.zoutiApiKey, existing.zoutiApiKey),
        kiwifyWebhookToken: resolveSecret(body.kiwifyWebhookToken, existing.kiwifyWebhookToken),
        whatsappProvider: body.whatsappProvider ?? existing.whatsappProvider,
        metaPhoneNumberId: body.metaPhoneNumberId ?? existing.metaPhoneNumberId,
        metaAccessToken: resolveSecret(body.metaAccessToken, existing.metaAccessToken),
        metaVerifyToken: body.metaVerifyToken ?? existing.metaVerifyToken,
        metaWabaId: body.metaWabaId ?? existing.metaWabaId,
        metaAppSecret: resolveSecret(body.metaAppSecret, existing.metaAppSecret),
        metaAdsAccessToken: resolveSecret(body.metaAdsAccessToken, existing.metaAdsAccessToken),
        metaAdsAccountId: body.metaAdsAccountId ?? existing.metaAdsAccountId,
        metaPixelId: body.metaPixelId ?? existing.metaPixelId,
        uazapiBaseUrl: body.uazapiBaseUrl ?? existing.uazapiBaseUrl,
        uazapiInstanceToken: resolveSecret(body.uazapiInstanceToken, existing.uazapiInstanceToken),
        notificationPhone: body.notificationPhone ?? existing.notificationPhone,
        brevoApiKey: resolveSecret(body.brevoApiKey, existing.brevoApiKey),
        brevoSenderEmail: body.brevoSenderEmail ?? existing.brevoSenderEmail,
        brevoSenderName: body.brevoSenderName ?? existing.brevoSenderName,
        instagramUsername: body.instagramUsername ?? existing.instagramUsername,
        instagramAccountId: body.instagramAccountId ?? existing.instagramAccountId,
        instagramAccessToken: resolveSecret(body.instagramAccessToken, existing.instagramAccessToken),
        instagramVerifyToken: body.instagramVerifyToken ?? existing.instagramVerifyToken,
        instagramPageId: body.instagramPageId ?? existing.instagramPageId,
        sidebarConfig: body.sidebarConfig !== undefined ? body.sidebarConfig : existing.sidebarConfig,
        updatedAt: new Date(),
      })
      .where(eq(settings.id, existing.id))
      .returning()
    return NextResponse.json({ ...updated, agentDisplayName: agentDisplayName ?? company.agentDisplayName ?? '' })
  }

  const [created] = await db
    .insert(settings)
    .values({
      companyId: company.id,
      hotmartWebhookToken: body.hotmartWebhookToken || null,
      hotmartClientId: body.hotmartClientId || null,
      hotmartClientSecret: body.hotmartClientSecret || null,
      greennWebhookToken: body.greennWebhookToken || null,
      greennPublicKey: body.greennPublicKey || null,
      greennApiKey: body.greennApiKey || null,
      zoutiWebhookToken: body.zoutiWebhookToken || null,
      zoutiApiKey: body.zoutiApiKey || null,
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
      sidebarConfig: body.sidebarConfig ?? null,
      updatedAt: new Date(),
    })
    .returning()
  return NextResponse.json({ ...created, agentDisplayName: agentDisplayName ?? company.agentDisplayName ?? '' })
}
