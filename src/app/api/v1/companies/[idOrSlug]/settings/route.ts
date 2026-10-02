export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, settings } from '@/lib/db/schema'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { eq } from 'drizzle-orm'
import { maskSettingsRow, shouldWriteSettingsField } from '@/lib/settings-mask'
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

  // Mesmo padrão de maskSettingsRow() de src/lib/settings-mask.ts (painel
  // humano): token/segredo nunca sai em texto plano numa resposta GET, nem
  // pra agente autenticado. Achado de auditoria (26/09/2026): esta rota
  // espalhava `...row` inteiro e só sobrescrevia uma lista manual de campos,
  // que deixava passar em claro supabaseDatabaseUrl, agentBiaApiKey,
  // agentLuanaApiKey, agentRenatoApiKey, agentPublicadorApiKey e instagramAppSecret.
  const maskedSettings = row ? maskSettingsRow(row) : null

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

  const parsedBody: unknown = await req.json().catch(() => null)
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: 'O corpo da requisição deve ser um objeto JSON.' }, { status: 400 })
  }
  const body = parsedBody as Record<string, unknown>
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
      'agentPublicadorApiKey',
      'allowedIps',
      'hotmartWebhookToken',
      'kiwifyWebhookToken',
      'greennWebhookToken',
      'zoutiWebhookToken',
    ]

    const invalidField = allowedKeys.find(key => body[key] != null && typeof body[key] !== 'string')
    if (invalidField) {
      return NextResponse.json({ error: `O campo ${invalidField} deve ser um texto.` }, { status: 400 })
    }
    const booleanKeys = ['hotmartEnabled', 'greennEnabled', 'kiwifyEnabled', 'zoutiEnabled'] as const
    const invalidBooleanField = booleanKeys.find(key => body[key] != null && typeof body[key] !== 'boolean')
    if (invalidBooleanField) {
      return NextResponse.json({ error: `O campo ${invalidBooleanField} deve ser um booleano.` }, { status: 400 })
    }

    // Achado de QA (26/09/2026): campo de credencial (mascarado no GET acima)
    // com valor vazio ou começando em "****" é ignorado aqui, senão um
    // caller que faz round-trip GET -> PATCH sem filtrar os campos
    // mascarados grava o placeholder por cima da credencial real. Cobre
    // agentBiaApiKey/agentLuanaApiKey/agentRenatoApiKey/agentPublicadorApiKey
    // (bearer tokens que autenticam agentes e workers nesta API) e os demais tokens da
    // allowlist abaixo. Ver shouldWriteSettingsField() em settings-mask.ts.
    const updateData: Record<string, unknown> = { updatedAt: new Date() }
    for (const k of allowedKeys) {
      if (shouldWriteSettingsField(k, body[k])) updateData[k] = body[k]
    }
    // Os gates são booleanos não-secretos e ficam fora da allowlist de strings:
    // shouldWriteSettingsField() filtra placeholders mascarados de credenciais.
    for (const key of booleanKeys) {
      if (typeof body[key] === 'boolean') updateData[key] = body[key]
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
      settings: updated ? maskSettingsRow(updated) : null,
      ...(warnings.length > 0 ? { warnings } : {}),
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro ao atualizar configurações'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
