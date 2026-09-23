export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

const TOKEN = 'codex-gramado-gap-20260923-readonly'

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get('token') !== TOKEN) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  const result = await db.execute(sql`
    with gramado as (
      select r.*
      from recovery_leads r
      join companies c on c.id = r.company_id
      where c.slug = 'gramado-plaza'
    ), classified as (
      select *, case
        when lower(coalesce(pipeline_stage, '')) in ('compareceu', 'cliente_compareceu')
          or lower(coalesce(status, '')) in ('compareceu', 'cliente compareceu')
          or lower(coalesce(event_type, '')) = 'compareceu' then 'compareceu'
        when lower(coalesce(pipeline_stage, '')) in ('perdido', 'cancelado')
          or lower(coalesce(status, '')) in ('perdido', 'cancelado') then 'perdido'
        when lower(coalesce(status, '')) in ('reserva confirmada', 'reserva_confirmada', 'completed')
          or lower(coalesce(pipeline_stage, '')) in ('fechado', 'contrato_fechado', 'reserva_confirmada', 'reserva confirmada', 'agendado', 'reserva_agendada')
          or lower(coalesce(event_type, '')) in ('reserva_confirmada', 'reserva confirmada', 'agendado') then 'fechado'
        else 'outro'
      end as dashboard_stage
      from gramado
    ), scoped as (
      select *, created_at >= timestamptz '2026-09-01 00:00:00-03'
        and created_at <= timestamptz '2026-09-30 23:59:59.999-03' as in_current_month
      from classified
    )
    select jsonb_build_object(
      'generated_at', now(),
      'company', (select jsonb_build_object('id', id, 'slug', slug, 'name', name) from companies where slug = 'gramado-plaza'),
      'all_time', jsonb_build_object(
        'agendado', count(*) filter (where pipeline_stage = 'agendado'),
        'legacy_fechado', count(*) filter (where pipeline_stage in ('fechado','contrato_fechado','reserva_confirmada','compareceu','procedimento_realizado')
          or status in ('converted','completed','approved') or event_type in ('compra_aprovada','reserva_confirmada')),
        'central_fechado', count(*) filter (where dashboard_stage = 'fechado'),
        'central_compareceu', count(*) filter (where dashboard_stage = 'compareceu'),
        'central_business_won', count(*) filter (where dashboard_stage in ('fechado','compareceu'))
      ),
      'current_month', jsonb_build_object(
        'agendado', count(*) filter (where in_current_month and pipeline_stage = 'agendado'),
        'legacy_fechado', count(*) filter (where in_current_month and (pipeline_stage in ('fechado','contrato_fechado','reserva_confirmada','compareceu','procedimento_realizado')
          or status in ('converted','completed','approved') or event_type in ('compra_aprovada','reserva_confirmada'))),
        'central_fechado', count(*) filter (where in_current_month and dashboard_stage = 'fechado'),
        'central_compareceu', count(*) filter (where in_current_month and dashboard_stage = 'compareceu'),
        'central_business_won', count(*) filter (where in_current_month and dashboard_stage in ('fechado','compareceu'))
      ),
      'agendado_missed_by_legacy_ids', coalesce(jsonb_agg(id order by id) filter (where pipeline_stage = 'agendado' and not (
        pipeline_stage in ('fechado','contrato_fechado','reserva_confirmada','compareceu','procedimento_realizado')
        or status in ('converted','completed','approved') or event_type in ('compra_aprovada','reserva_confirmada'))), '[]'::jsonb),
      'agendado_outside_current_month_ids', coalesce(jsonb_agg(id order by id) filter (where pipeline_stage = 'agendado' and not in_current_month), '[]'::jsonb)
    ) as payload
    from scoped
  `)

  const payload = (result as { rows?: { payload?: unknown }[] }).rows?.[0]?.payload
  return NextResponse.json(payload ?? {})
}
