import { NextRequest, NextResponse } from 'next/server'
import { getCurrentCompany, requireCompanyRole, ForbiddenError, AuthError } from '@/lib/auth'
import { db } from '@/lib/db'
import { settings } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'
import { parsePipelineColumns, pipelineColumnsUpdateSql, DEFAULT_PIPELINE_STAGE_IDS, DEFAULT_PIPELINE_COLUMNS } from '@/lib/pipeline-columns-update'
import { sacSqlRows } from '@/lib/sac-pending-rules'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const company = await getCurrentCompany()
    if (!company) {
      return NextResponse.json({ error: 'Empresa não autenticada' }, { status: 401 })
    }

    const [setting] = await db
      .select({ columns: settings.pipelineColumns })
      .from(settings)
      .where(eq(settings.companyId, company.id))

    return NextResponse.json({ columns: setting?.columns || null })
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Erro ao carregar colunas' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { company } = await requireCompanyRole('admin')
    const body: unknown = await req.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 })
    const input = body as Record<string, unknown>
    let columns
    try { columns = parsePipelineColumns(input.columns) }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Colunas inválidas' }, { status: 400 }) }
    const from = typeof input.migrateFromColumn === 'string' ? input.migrateFromColumn : null
    const to = typeof input.migrateToColumn === 'string' ? input.migrateToColumn : null
    const ids = new Set(columns.map(c => c.id))
    if ((from === null) !== (to === null) || (from && (ids.has(from) || !to || !ids.has(to)))) {
      return NextResponse.json({ error: 'Migração exige coluna removida e destino existente.' }, { status: 400 })
    }
    const [previous] = await db.select({ columns: settings.pipelineColumns }).from(settings).where(eq(settings.companyId, company.id))
    let expectedSnapshot
    if (input.expectedColumns !== undefined) {
      try { expectedSnapshot=parsePipelineColumns(input.expectedColumns) }
      catch { return NextResponse.json({ error:'Versão das colunas inválida.' }, { status:400 }) }
      const effectivePrevious=Array.isArray(previous?.columns) && previous.columns.length ? parsePipelineColumns(previous.columns) : DEFAULT_PIPELINE_COLUMNS
      if (previous?.columns && JSON.stringify(expectedSnapshot)!==JSON.stringify(effectivePrevious)) {
        return NextResponse.json({ error:'As colunas mudaram desde que você abriu esta tela. Recarregue antes de editar.' }, { status:409 })
      }
    }
    const previousIds = Array.isArray(previous?.columns) && previous.columns.length
      ? previous.columns.map(c => c.id) : expectedSnapshot?.map(c=>c.id) ?? DEFAULT_PIPELINE_STAGE_IDS
    const removed = previousIds.filter(id => !ids.has(id))
    if (removed.length && (removed.length !== 1 || removed[0] !== from)) {
      return NextResponse.json({ error: 'Exclua uma coluna por vez, indicando destino para seus leads.' }, { status: 400 })
    }
    if (from && !previousIds.includes(from)) return NextResponse.json({ error: 'Coluna de origem não existe.' }, { status: 400 })
    // Configuration and lead migration commit or roll back together in one statement.
    const [saved] = sacSqlRows(await db.execute(pipelineColumnsUpdateSql(company.id, columns, from, to, previous?.columns ?? null)))
    if (Number(saved.saved) === 0) return NextResponse.json({ error: 'As colunas foram alteradas por outro administrador. Recarregue antes de editar.' }, { status: 409 })
    return NextResponse.json({ success: true, columns })
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Erro ao salvar colunas' }, { status: error instanceof ForbiddenError || error instanceof AuthError ? error.status : 500 })
  }
}
