import { sql } from 'drizzle-orm'

export interface PipelineColumn { id: string; label: string; color: string }
export const DEFAULT_PIPELINE_COLUMNS: PipelineColumn[] = [
  {id:'novo_contato',label:'Novo Contato',color:'#3987e5'},
  {id:'em_atendimento',label:'Em Atendimento',color:'#d95926'},
  {id:'qualificado',label:'Qualificado',color:'#199e70'},
  {id:'agendado',label:'Agendado / Reserva',color:'#9085e9'},
  {id:'compareceu',label:'Compareceu',color:'#14b8a6'},
  {id:'fechado',label:'Fechado / Ganho',color:'#008300'},
  {id:'perdido',label:'Perdido',color:'#ef4444'},
]
export const DEFAULT_PIPELINE_STAGE_IDS = DEFAULT_PIPELINE_COLUMNS.map(c=>c.id)

export function parsePipelineColumns(value: unknown): PipelineColumn[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new Error('Informe de 1 a 100 colunas válidas.')
  const ids = new Set<string>()
  return value.map(column => {
    if (!column || typeof column !== 'object' || Array.isArray(column)) throw new Error('Coluna inválida.')
    const { id, label, color } = column as Record<string, unknown>
    if (typeof id !== 'string' || !id.trim() || id.length > 128 || ids.has(id)) throw new Error('ID de coluna inválido ou duplicado.')
    if (typeof label !== 'string' || !label.trim() || label.length > 150) throw new Error('Nome de coluna inválido.')
    if (typeof color !== 'string' || !color.trim() || color.length > 64) throw new Error('Cor de coluna inválida.')
    ids.add(id)
    return { id, label: label.trim(), color: color.trim() }
  })
}

/** SQL counterpart of inferPipelineStage; regression tests compare both with
 * real SQL for explicit stage precedence and every existing fallback. */
export function effectivePipelineStageSql() {
  return sql`CASE
    WHEN pipeline_stage IS NOT NULL AND pipeline_stage <> '' THEN pipeline_stage
    WHEN status = 'converted' OR event_type = 'compra_aprovada' THEN 'fechado'
    WHEN status = 'in_progress' THEN 'em_atendimento'
    WHEN event_type IN ('pix', 'boleto') THEN 'qualificado'
    WHEN priority > 1 THEN 'agendado'
    ELSE 'novo_contato' END`
}

export function pipelineColumnsUpdateSql(companyId: number, columns: PipelineColumn[], from: string | null, to: string | null, previousColumns: unknown = null) {
  const encodedColumns = JSON.stringify(columns)
  return sql`
    WITH saved AS (
      INSERT INTO settings (company_id, pipeline_columns, updated_at)
      VALUES (${companyId}, ${encodedColumns}::jsonb, NOW())
      ON CONFLICT (company_id) DO UPDATE SET pipeline_columns = EXCLUDED.pipeline_columns,
        sac_followup_stage_ids = (
          SELECT COALESCE(jsonb_agg(stage_id), '[]'::jsonb)
          FROM jsonb_array_elements_text(settings.sac_followup_stage_ids) AS stage_ids(stage_id)
          WHERE stage_id IN (SELECT value->>'id' FROM jsonb_array_elements(EXCLUDED.pipeline_columns))
        ), updated_at = NOW()
      WHERE settings.pipeline_columns IS NOT DISTINCT FROM ${previousColumns === null ? null : JSON.stringify(previousColumns)}::jsonb
      RETURNING id
    ), moved AS (
      UPDATE recovery_leads SET pipeline_stage = ${to}, updated_at = NOW(), context_version = coalesce(context_version, 1) + 1
      WHERE company_id = ${companyId} AND ${from}::text IS NOT NULL
        AND ${effectivePipelineStageSql()} = ${from}
        AND EXISTS (SELECT 1 FROM saved)
      RETURNING id
    )
    SELECT (SELECT count(*)::integer FROM moved) AS migrated, (SELECT count(*)::integer FROM saved) AS saved
  `
}
