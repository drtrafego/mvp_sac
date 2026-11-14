import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireCompany, requireCompanyRole, AuthError, ForbiddenError, forbiddenResponse } from '@/lib/auth'
import { sql } from 'drizzle-orm'
import { postgresTextArrayLiteral } from '@/lib/instagram-story-automation'

function authError(error: unknown): boolean { return error instanceof AuthError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 401) }
function forbidden(error: unknown): boolean { return error instanceof ForbiddenError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 403) }
function string(value: unknown): string | null { return typeof value === 'string' ? value.trim() : null }
function bytes(value: string): number { return new TextEncoder().encode(value).length }
function validate(body: Record<string, unknown>): { error?: string; values?: { name: string; keywords: string[]; matchType: string; storyId: string | null; dmMessage: string; mode: string; isActive: boolean } } {
  const name = string(body.name); const dmMessage = string(body.dmMessage); const matchType = string(body.matchType) ?? 'contains'; const mode = string(body.mode) ?? 'observe'
  const storyId = body.storyId === null || body.storyId === undefined || string(body.storyId) === '' ? null : string(body.storyId)
  const keywords = Array.isArray(body.keywords) ? body.keywords.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : typeof body.keywords === 'string' ? body.keywords.split(',').map(item => item.trim()).filter(Boolean) : []
  if (!name) return { error: 'O nome da regra é obrigatório.' }
  if (!dmMessage) return { error: 'A mensagem do Direct é obrigatória.' }
  if (bytes(dmMessage) > 1000) return { error: 'A mensagem do Direct pode ter no máximo 1.000 bytes.' }
  if (!['any', 'contains', 'exact'].includes(matchType)) return { error: 'Tipo de resposta inválido.' }
  if (matchType !== 'any' && !keywords.length) return { error: 'Informe ao menos uma palavra para esse tipo de regra.' }
  if (!['observe', 'send'].includes(mode)) return { error: 'Modo inválido.' }
  if (storyId && !/^\d+$/.test(storyId)) return { error: 'O Story selecionado é inválido.' }
  if (keywords.some(keyword => keyword.length > 120)) return { error: 'Cada palavra pode ter no máximo 120 caracteres.' }
  if (keywords.some(keyword => keyword.includes(','))) return { error: 'Cada palavra não pode conter vírgula.' }
  return { values: { name, keywords, matchType, storyId, dmMessage, mode, isActive: body.isActive === true } }
}

export async function GET() {
  try {
    const company = await requireCompany()
    const result = await db.execute(sql`SELECT id, company_id AS "companyId", name, keywords, match_type AS "matchType", story_id AS "storyId", dm_message AS "dmMessage", mode, is_active AS "isActive", enabled_at AS "enabledAt", created_at AS "createdAt", updated_at AS "updatedAt" FROM instagram_story_automations WHERE company_id = ${company.id} ORDER BY created_at DESC`)
    return NextResponse.json({ enabled: true, automations: Array.isArray(result) ? result : result.rows ?? [] })
  } catch (error) {
    if (authError(error)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    if (forbidden(error)) return forbiddenResponse()
    console.error(`[Story Automations GET] name=${error instanceof Error ? error.name : 'ErroDesconhecido'}`)
    return NextResponse.json({ error: 'Não foi possível carregar as automações de Story.' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const { company } = await requireCompanyRole('admin')
    const parsed: unknown = await request.json().catch(() => null)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NextResponse.json({ error: 'O corpo deve ser um objeto JSON.' }, { status: 400 })
    const checked = validate(parsed as Record<string, unknown>)
    if (!checked.values) return NextResponse.json({ error: checked.error }, { status: 400 })
    const value = checked.values
    // enabled_at é decidido aqui, nunca aceito do navegador. Criar ativa inicia
    // o corte forward-only neste instante; reativação segue a mesma regra no PATCH.
    const keywords = postgresTextArrayLiteral(value.keywords)
    const result = await db.execute(sql`INSERT INTO instagram_story_automations (company_id, name, keywords, match_type, story_id, dm_message, mode, is_active, enabled_at) VALUES (${company.id}, ${value.name}, ${keywords}::text[], ${value.matchType}, ${value.storyId}, ${value.dmMessage}, ${value.mode}, ${value.isActive}, ${value.isActive ? new Date() : null}) RETURNING id, company_id AS "companyId", name, keywords, match_type AS "matchType", story_id AS "storyId", dm_message AS "dmMessage", mode, is_active AS "isActive", enabled_at AS "enabledAt", created_at AS "createdAt", updated_at AS "updatedAt"`)
    return NextResponse.json({ automation: (Array.isArray(result) ? result : result.rows ?? [])[0] }, { status: 201 })
  } catch (error) {
    if (authError(error)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    if (forbidden(error)) return forbiddenResponse()
    console.error(`[Story Automations POST] name=${error instanceof Error ? error.name : 'ErroDesconhecido'}`)
    return NextResponse.json({ error: 'Não foi possível criar a automação de Story.' }, { status: 500 })
  }
}
