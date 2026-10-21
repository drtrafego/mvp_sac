import { NextRequest, NextResponse } from 'next/server'
import { desc, eq } from 'drizzle-orm'
import { requireCompanyRole, AuthError, ForbiddenError, forbiddenResponse } from '@/lib/auth'
import { db } from '@/lib/db'
import { instagramInboundTagRules } from '@/lib/db/schema'
import { MAX_TAG_LENGTH, normalizeTag } from '@/lib/lead-tags'

const TRIGGERS = ['direct', 'story_reply'] as const
const MATCH_TYPES = ['contains', 'exact', 'any'] as const

function unauthorized(error: unknown) {
  return error instanceof AuthError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 401)
}
function isForbidden(error: unknown) { return error instanceof ForbiddenError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 403) }

export async function GET() {
  try {
    const { company } = await requireCompanyRole('admin')
    const rules = await db.select().from(instagramInboundTagRules)
      .where(eq(instagramInboundTagRules.companyId, company.id))
      .orderBy(desc(instagramInboundTagRules.createdAt))
    return NextResponse.json({ rules })
  } catch (error) {
    if (unauthorized(error)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    if (isForbidden(error)) return forbiddenResponse()
    return NextResponse.json({ error: 'Erro ao listar regras de tag.' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { company } = await requireCompanyRole('admin')
    const body: unknown = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'O corpo deve ser um objeto JSON.' }, { status: 400 })
    const value = body as Record<string, unknown>
    const name = typeof value.name === 'string' ? value.name.trim() : ''
    const rawTag = typeof value.tag === 'string' ? value.tag.trim() : ''
    const tag = rawTag ? normalizeTag(rawTag) : ''
    const trigger = value.trigger
    const matchType = value.matchType ?? (typeof value.keywords === 'string' && value.keywords.trim() ? 'contains' : 'any')
    if (!name) return NextResponse.json({ error: 'O nome é obrigatório.' }, { status: 400 })
    if (!tag || rawTag.length > MAX_TAG_LENGTH) return NextResponse.json({ error: `A tag deve ter entre 1 e ${MAX_TAG_LENGTH} caracteres.` }, { status: 400 })
    if (typeof trigger !== 'string' || !TRIGGERS.includes(trigger as typeof TRIGGERS[number])) return NextResponse.json({ error: 'Gatilho inválido.' }, { status: 400 })
    if (typeof matchType !== 'string' || !MATCH_TYPES.includes(matchType as typeof MATCH_TYPES[number])) return NextResponse.json({ error: 'Tipo de correspondência inválido.' }, { status: 400 })
    if (value.keywords !== undefined && value.keywords !== null && typeof value.keywords !== 'string') return NextResponse.json({ error: 'Palavras-chave deve ser texto.' }, { status: 400 })
    const [rule] = await db.insert(instagramInboundTagRules).values({
      companyId: company.id, name, tag, trigger, matchType,
      keywords: typeof value.keywords === 'string' ? value.keywords.trim() || null : null,
      isActive: typeof value.isActive === 'boolean' ? value.isActive : true,
    }).returning()
    return NextResponse.json({ rule }, { status: 201 })
  } catch (error) {
    if (unauthorized(error)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    if (isForbidden(error)) return forbiddenResponse()
    console.error('[Instagram Tag Rules POST]', error)
    return NextResponse.json({ error: 'Erro ao criar regra de tag.' }, { status: 500 })
  }
}
