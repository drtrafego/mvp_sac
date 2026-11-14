import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireCompanyRole, AuthError, ForbiddenError, forbiddenResponse } from '@/lib/auth'
import { sql } from 'drizzle-orm'
import { isStoryTriggerEnabledForSlug, postgresTextArrayLiteral } from '@/lib/instagram-story-automation'

type Context = { params: Promise<{ id: string }> }
function unauthorized(error: unknown): boolean { return error instanceof AuthError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 401) }
function forbidden(error: unknown): boolean { return error instanceof ForbiddenError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 403) }
function getRows<T>(result: unknown): T[] { return Array.isArray(result) ? result as T[] : result && typeof result === 'object' && Array.isArray((result as { rows?: unknown[] }).rows) ? (result as { rows: T[] }).rows : [] }
function asId(id: string): number | null { return /^[1-9]\d*$/.test(id) ? Number(id) : null }
function text(value: unknown): string | null { return typeof value === 'string' ? value.trim() : null }
function validPatch(body: Record<string, unknown>): string | null {
  if (body.matchType !== undefined && (typeof body.matchType !== 'string' || !['any', 'contains', 'exact'].includes(body.matchType))) return 'Tipo de resposta inválido.'
  if (body.mode !== undefined && (typeof body.mode !== 'string' || !['observe', 'send'].includes(body.mode))) return 'Modo inválido.'
  if (body.storyId !== undefined && body.storyId !== null && (typeof body.storyId !== 'string' || (body.storyId.trim() && !/^\d+$/.test(body.storyId.trim())))) return 'O Story selecionado é inválido.'
  if (body.dmMessage !== undefined && (typeof body.dmMessage !== 'string' || !body.dmMessage.trim() || new TextEncoder().encode(body.dmMessage.trim()).length > 1000)) return 'A mensagem do Direct é obrigatória e pode ter no máximo 1.000 bytes.'
  const keywords = Array.isArray(body.keywords) ? body.keywords.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : undefined
  if (keywords?.some(keyword => keyword.includes(','))) return 'Cada palavra não pode conter vírgula.'
  const matchType = typeof body.matchType === 'string' ? body.matchType : undefined
  if (matchType && matchType !== 'any' && keywords && keywords.length === 0) return 'Informe ao menos uma palavra para esse tipo de regra.'
  return null
}

export async function GET(_request: NextRequest, { params }: Context) {
  try {
    const { company } = await requireCompanyRole('admin'); const id = asId((await params).id)
    if (!isStoryTriggerEnabledForSlug(company.slug)) return NextResponse.json({ error: 'Disponível apenas para a conta piloto.' }, { status: 403 })
    if (!id) return NextResponse.json({ error: 'ID inválido.' }, { status: 400 })
    const automation = getRows(await db.execute(sql`SELECT id, company_id AS "companyId", name, keywords, match_type AS "matchType", story_id AS "storyId", dm_message AS "dmMessage", mode, is_active AS "isActive", enabled_at AS "enabledAt", created_at AS "createdAt", updated_at AS "updatedAt" FROM instagram_story_automations WHERE id = ${id} AND company_id = ${company.id}`))[0]
    return automation ? NextResponse.json({ automation }) : NextResponse.json({ error: 'Automação não encontrada.' }, { status: 404 })
  } catch (error) { if (unauthorized(error)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 }); if (forbidden(error)) return forbiddenResponse(); return NextResponse.json({ error: 'Não foi possível carregar a automação.' }, { status: 500 }) }
}

export async function PATCH(request: NextRequest, { params }: Context) {
  try {
    const { company } = await requireCompanyRole('admin'); const id = asId((await params).id)
    if (!isStoryTriggerEnabledForSlug(company.slug)) return NextResponse.json({ error: 'Disponível apenas para a conta piloto.' }, { status: 403 })
    if (!id) return NextResponse.json({ error: 'ID inválido.' }, { status: 400 })
    const parsed: unknown = await request.json().catch(() => null)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NextResponse.json({ error: 'O corpo deve ser um objeto JSON.' }, { status: 400 })
    const body = parsed as Record<string, unknown>; const error = validPatch(body); if (error) return NextResponse.json({ error }, { status: 400 })
    const current = getRows<{ isActive: boolean; matchType: string; keywords: string[]; mode: string; storyId: string | null; name: string; dmMessage: string }>(await db.execute(sql`SELECT is_active AS "isActive", match_type AS "matchType", keywords, mode, story_id AS "storyId", name, dm_message AS "dmMessage" FROM instagram_story_automations WHERE id = ${id} AND company_id = ${company.id}`))[0]
    if (!current) return NextResponse.json({ error: 'Automação não encontrada.' }, { status: 404 })
    const keywords = body.keywords === undefined ? current.keywords : Array.isArray(body.keywords) ? body.keywords.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : []
    const matchType = typeof body.matchType === 'string' ? body.matchType : current.matchType
    if (matchType !== 'any' && !keywords.length) return NextResponse.json({ error: 'Informe ao menos uma palavra para esse tipo de regra.' }, { status: 400 })
    const isActive = typeof body.isActive === 'boolean' ? body.isActive : current.isActive
    const name = body.name === undefined ? null : text(body.name); if (body.name !== undefined && !name) return NextResponse.json({ error: 'O nome da regra é obrigatório.' }, { status: 400 })
    const storyId = body.storyId === undefined ? current.storyId : text(body.storyId) || null
    const mode = typeof body.mode === 'string' ? body.mode : current.mode
    const dmMessage = body.dmMessage === undefined ? current.dmMessage : text(body.dmMessage)!
    const resetEnabledAt = isActive && (!current.isActive || (current.mode !== 'send' && mode === 'send') || (current.isActive && (current.matchType !== matchType || current.storyId !== storyId || current.dmMessage !== dmMessage || JSON.stringify(current.keywords) !== JSON.stringify(keywords))))
    const keywordLiteral = postgresTextArrayLiteral(keywords)
    const result = await db.execute(sql`UPDATE instagram_story_automations SET name = COALESCE(${name}, name), keywords = ${keywordLiteral}::text[], match_type = ${matchType}, story_id = ${storyId}, dm_message = ${dmMessage}, mode = ${mode}, is_active = ${isActive}, enabled_at = CASE WHEN ${resetEnabledAt} THEN now() ELSE enabled_at END, updated_at = now() WHERE id = ${id} AND company_id = ${company.id} RETURNING id, company_id AS "companyId", name, keywords, match_type AS "matchType", story_id AS "storyId", dm_message AS "dmMessage", mode, is_active AS "isActive", enabled_at AS "enabledAt", created_at AS "createdAt", updated_at AS "updatedAt"`)
    return NextResponse.json({ automation: getRows(result)[0] })
  } catch (error) { if (unauthorized(error)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 }); if (forbidden(error)) return forbiddenResponse(); console.error(`[Story Automations PATCH] name=${error instanceof Error ? error.name : 'ErroDesconhecido'}`); return NextResponse.json({ error: 'Não foi possível atualizar a automação.' }, { status: 500 }) }
}

export async function DELETE(_request: NextRequest, { params }: Context) {
  try { const { company } = await requireCompanyRole('admin'); if (!isStoryTriggerEnabledForSlug(company.slug)) return NextResponse.json({ error: 'Disponível apenas para a conta piloto.' }, { status: 403 }); const id = asId((await params).id); if (!id) return NextResponse.json({ error: 'ID inválido.' }, { status: 400 }); const deleted = getRows(await db.execute(sql`DELETE FROM instagram_story_automations WHERE id = ${id} AND company_id = ${company.id} RETURNING id`))[0]; return deleted ? NextResponse.json({ success: true }) : NextResponse.json({ error: 'Automação não encontrada.' }, { status: 404 }) } catch (error) { if (unauthorized(error)) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 }); if (forbidden(error)) return forbiddenResponse(); return NextResponse.json({ error: 'Não foi possível excluir a automação.' }, { status: 500 }) }
}
