import { NextRequest, NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { metaMessageTemplates } from '@/lib/db/schema'
import { AuthError, ForbiddenError, getCompanyAccess } from '@/lib/auth'
import { roleSatisfies } from '@/lib/company-role'
import { parseSacObject, SacInputError, isUniqueConstraintError } from '@/lib/sac-access'
import { validateMetaTemplateComponents } from '@/lib/meta-template-validation'

const CATEGORIES = new Set(['AUTHENTICATION', 'MARKETING', 'UTILITY'])
const json = (body: unknown, init?: ResponseInit) => { const res = NextResponse.json(body, init); res.headers.set('Cache-Control', 'no-store'); return res }

function validTemplate(body: Record<string, unknown>) {
  if (typeof body.name !== 'string' || !/^[a-z0-9_]{1,512}$/.test(body.name)) throw new SacInputError('Nome inválido. Use letras minúsculas, números e sublinhado.')
  const language = body.language === undefined ? 'pt_BR' : body.language
  if (typeof language !== 'string' || !/^[a-z]{2}_[A-Z]{2}$/.test(language)) throw new SacInputError('Idioma inválido.')
  if (typeof body.category !== 'string' || !CATEGORIES.has(body.category)) throw new SacInputError('Categoria inválida.')
  return { name: body.name, language, category: body.category, components: validateMetaTemplateComponents(body.components) }
}

export async function GET(): Promise<NextResponse> {
  try {
    const { company } = await getCompanyAccess()
    return json({ templates: await db.select().from(metaMessageTemplates).where(eq(metaMessageTemplates.companyId, company.id)).orderBy(desc(metaMessageTemplates.updatedAt)) })
  } catch (error) {
    if (error instanceof AuthError || error instanceof ForbiddenError) return json({ error: error.message }, { status: error.status })
    return json({ error: 'Não foi possível listar os templates.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const { company, role, user } = await getCompanyAccess()
    if (!roleSatisfies(role, 'admin')) throw new ForbiddenError('Somente administradores podem criar templates Meta.')
    const template = validTemplate(parseSacObject(await req.json().catch(() => null)))
    const [created] = await db.insert(metaMessageTemplates).values({ companyId: company.id, ...template, status: 'DRAFT', createdBy: user.id, updatedAt: new Date() }).returning()
    return json({ template: created }, { status: 201 })
  } catch (error) {
    if (error instanceof SacInputError || error instanceof AuthError || error instanceof ForbiddenError) return json({ error: error.message }, { status: error.status })
    if (isUniqueConstraintError(error)) return json({ error: 'Já existe um template com esse nome e idioma nesta empresa.' }, { status: 409 })
    return json({ error: 'Não foi possível criar o template.' }, { status: 500 })
  }
}
