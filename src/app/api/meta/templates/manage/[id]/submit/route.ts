import { NextResponse } from 'next/server'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { metaMessageTemplates, settings } from '@/lib/db/schema'
import { AuthError, ForbiddenError, getCompanyAccess } from '@/lib/auth'
import { roleSatisfies } from '@/lib/company-role'
import { submitMetaTemplate } from '@/lib/whatsapp/meta'

type Params = { params: Promise<{ id: string }> }
const json = (body: unknown, init?: ResponseInit) => { const res = NextResponse.json(body, init); res.headers.set('Cache-Control', 'no-store'); return res }

export async function POST(_req: Request, { params }: Params): Promise<NextResponse> {
  let token: string | null | undefined
  try {
    const templateId = Number((await params).id)
    if (!Number.isSafeInteger(templateId) || templateId <= 0) return json({ error: 'ID inválido.' }, { status: 400 })
    const { company, role, user } = await getCompanyAccess()
    if (!roleSatisfies(role, 'admin')) throw new ForbiddenError('Somente administradores podem submeter templates à Meta.')
    const [template] = await db.select().from(metaMessageTemplates).where(and(eq(metaMessageTemplates.id, templateId), eq(metaMessageTemplates.companyId, company.id)))
    if (!template) return json({ error: 'Template não encontrado.' }, { status: 404 })
    if (!['DRAFT', 'REJECTED', 'FAILED'].includes(template.status)) return json({ error: 'Template já está em processamento ou não pode ser submetido.' }, { status: 409 })
    const [config] = await db.select().from(settings).where(eq(settings.companyId, company.id))
    token = config?.metaAccessToken
    if (config?.whatsappProvider && config.whatsappProvider !== 'meta') return json({ error: 'WhatsApp Meta Cloud API não está ativo para esta empresa.' }, { status: 409 })
    if (!config?.metaWabaId || !token) return json({ error: 'Configure o WABA ID e o Access Token Meta primeiro.' }, { status: 400 })
    const [claimed] = await db.update(metaMessageTemplates).set({ status: 'SUBMITTING', requestCount: sql`${metaMessageTemplates.requestCount} + 1`, submittedBy: user.id, submittedAt: new Date(), updatedAt: new Date() }).where(and(eq(metaMessageTemplates.id, template.id), eq(metaMessageTemplates.companyId, company.id), inArray(metaMessageTemplates.status, ['DRAFT', 'REJECTED', 'FAILED']))).returning()
    if (!claimed) return json({ error: 'Outra submissão deste template já está em andamento.' }, { status: 409 })
    try {
      const result = await submitMetaTemplate(config.metaWabaId, token, { name: claimed.name, language: claimed.language, category: claimed.category, components: claimed.components })
      const [updated] = await db.update(metaMessageTemplates).set({ status: result.status ?? 'PENDING', metaTemplateId: result.id ?? claimed.metaTemplateId, rejectionReason: null, lastMetaResponse: result.raw, syncedAt: new Date(), updatedAt: new Date() }).where(and(eq(metaMessageTemplates.id, claimed.id), eq(metaMessageTemplates.companyId, company.id), eq(metaMessageTemplates.status, 'SUBMITTING'))).returning()
      if (!updated) return json({ error: 'O estado mudou durante a submissão. Sincronize antes de tentar novamente.' }, { status: 409 })
      return json({ template: updated })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível submeter o template à Meta.'
      const safeMessage = token ? message.replaceAll(token, '[token-redigido]') : message
      await db.update(metaMessageTemplates).set({ status: 'FAILED', lastMetaResponse: { error: safeMessage }, updatedAt: new Date() }).where(and(eq(metaMessageTemplates.id, claimed.id), eq(metaMessageTemplates.companyId, company.id), eq(metaMessageTemplates.status, 'SUBMITTING')))
      return json({ error: safeMessage }, { status: 502 })
    }
  } catch (error) {
    if (error instanceof AuthError || error instanceof ForbiddenError) return json({ error: error.message }, { status: error.status })
    const message = error instanceof Error ? error.message : 'Não foi possível submeter o template à Meta.'
    return json({ error: token ? message.replaceAll(token, '[token-redigido]') : message }, { status: 502 })
  }
}
