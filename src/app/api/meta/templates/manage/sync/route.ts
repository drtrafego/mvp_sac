import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { metaMessageTemplates, settings } from '@/lib/db/schema'
import { AuthError, ForbiddenError, getCompanyAccess } from '@/lib/auth'
import { roleSatisfies } from '@/lib/company-role'
import { listAllMetaTemplates } from '@/lib/whatsapp/meta'

const json = (body: unknown, init?: ResponseInit) => { const res = NextResponse.json(body, init); res.headers.set('Cache-Control', 'no-store'); return res }

export async function POST(): Promise<NextResponse> {
  let token: string | null | undefined
  try {
    const { company, role } = await getCompanyAccess()
    if (!roleSatisfies(role, 'admin')) throw new ForbiddenError('Somente administradores podem sincronizar templates Meta.')
    const [config] = await db.select().from(settings).where(eq(settings.companyId, company.id))
    token = config?.metaAccessToken
    if (config?.whatsappProvider && config.whatsappProvider !== 'meta') return json({ error: 'WhatsApp Meta Cloud API não está ativo para esta empresa.' }, { status: 409 })
    if (!config?.metaWabaId || !token) return json({ error: 'Configure o WABA ID e o Access Token Meta primeiro.' }, { status: 400 })
    const remoteTemplates = await listAllMetaTemplates(config.metaWabaId, token)
    const now = new Date()
    for (const remote of remoteTemplates) {
      await db.insert(metaMessageTemplates).values({ companyId: company.id, name: remote.name, language: remote.language, category: remote.category, components: remote.components, status: remote.status, metaTemplateId: remote.id ?? null, rejectionReason: remote.rejected_reason ?? null, lastMetaResponse: remote, syncedAt: now, updatedAt: now }).onConflictDoUpdate({
        target: [metaMessageTemplates.companyId, metaMessageTemplates.name, metaMessageTemplates.language],
        set: { category: remote.category, components: remote.components, status: remote.status, metaTemplateId: remote.id ?? null, rejectionReason: remote.rejected_reason ?? null, lastMetaResponse: remote, syncedAt: now, updatedAt: now },
      })
    }
    return json({ synchronized: remoteTemplates.length })
  } catch (error) {
    if (error instanceof AuthError || error instanceof ForbiddenError) return json({ error: error.message }, { status: error.status })
    const message = error instanceof Error ? error.message : 'Não foi possível sincronizar os templates da Meta.'
    return json({ error: token ? message.replaceAll(token, '[token-redigido]') : message }, { status: 502 })
  }
}
