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

const WRITABLE_SETTING_FIELDS = [
  ['hotmartEnabled', 'boolean'],
  ['greennEnabled', 'boolean'],
  ['zoutiEnabled', 'boolean'],
  ['kiwifyEnabled', 'boolean'],
  ['hotmartWebhookToken', 'string'],
  ['hotmartClientId', 'string'],
  ['hotmartClientSecret', 'string'],
  ['greennWebhookToken', 'string'],
  ['greennPublicKey', 'string'],
  ['greennApiKey', 'string'],
  ['zoutiWebhookToken', 'string'],
  ['zoutiApiKey', 'string'],
  ['kiwifyWebhookToken', 'string'],
  ['whatsappProvider', 'string'],
  ['metaPhoneNumberId', 'string'],
  ['metaAccessToken', 'string'],
  ['metaVerifyToken', 'string'],
  ['metaWabaId', 'string'],
  ['metaAppSecret', 'string'],
  ['metaAdsAccessToken', 'string'],
  ['metaAdsAccountId', 'string'],
  ['metaPixelId', 'string'],
  ['uazapiBaseUrl', 'string'],
  ['uazapiInstanceToken', 'string'],
  ['notificationPhone', 'string'],
  ['brevoApiKey', 'string'],
  ['brevoSenderEmail', 'string'],
  ['brevoSenderName', 'string'],
  ['instagramUsername', 'string'],
  ['instagramAccountId', 'string'],
  ['instagramAccessToken', 'string'],
  ['instagramVerifyToken', 'string'],
  ['instagramPageId', 'string'],
  ['instagramAppSecret', 'string'],
  ['sidebarConfig', 'present'],
] as const

function buildWritableSettingsFields(body: Record<string, unknown>): Record<string, unknown> {
  const writableFields: Record<string, unknown> = {}

  for (const [key, expectedType] of WRITABLE_SETTING_FIELDS) {
    const value = body[key]
    const hasExpectedType = expectedType === 'present'
      ? value !== undefined
      : typeof value === expectedType

    if (hasExpectedType && shouldWriteSettingsField(key, value)) {
      writableFields[key] = value
    }
  }

  return writableFields
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
  const body = await req.json() as Record<string, unknown>
  let agentDisplayName: string | undefined
  try {
    agentDisplayName = parseAgentDisplayName(body.agentDisplayName)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Nome do bot inválido.' },
      { status: 400 },
    )
  }

  if (agentDisplayName !== undefined) {
    await db
      .update(companies)
      .set({ agentDisplayName, agentDisplayNameManual: true, updatedAt: new Date() })
      .where(eq(companies.id, company.id))
  }

  // O body passa por uma única barreira antes de chegar a qualquer escrita.
  // O mesmo objeto parcial alimenta INSERT e UPDATE, então placeholders
  // mascarados não podem escapar por um caminho diferente.
  const writableFields = buildWritableSettingsFields(body)
  const updatedAt = new Date()

  const [saved] = await db
    .insert(settings)
    .values({
      companyId: company.id,
      hotmartEnabled: true,
      greennEnabled: true,
      zoutiEnabled: true,
      kiwifyEnabled: true,
      whatsappProvider: 'meta',
      ...writableFields,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: settings.companyId,
      set: { ...writableFields, updatedAt },
    })
    .returning()
  return NextResponse.json({ ...maskSettingsRow(saved), agentDisplayName: agentDisplayName ?? company.agentDisplayName ?? '' })
}
