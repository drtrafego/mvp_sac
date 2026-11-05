import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { sql } from 'drizzle-orm'

export const runtime = 'nodejs'

const SCHEMA = 'sac_isabela_fanini_bela'
const TENANT = 'isabela-fanini'
const AGENT = 'bela'
const SOURCE = 'quiz_isabela'
const QUESTIONS = ['idade', 'momento', 'sente', 'area', 'cansaco', 'favor', 'msg', 'briga', 'gosta', 'trava', 'medo', 'frases', 'freq', 'nao', 'aceitou', 'tentou', 'futuro', 'vida', 'desejo', 'pronta']

type Payload = {
  submissionId?: string
  consent?: boolean
  contact?: { name?: string; phone?: string; email?: string }
  answers?: Record<string, string[]>
  result?: { profile?: string; profileName?: string; score?: number; range?: string }
  attribution?: { fbclid?: string | null; fbc?: string | null; fbp?: string | null; utms?: Record<string, string> }
}

export async function POST(request: NextRequest) {
  const secret = process.env.ISABELA_QUIZ_API_KEY
  if (!secret) return NextResponse.json({ error: 'Integração indisponível' }, { status: 503 })
  const timestamp = request.headers.get('x-quiz-timestamp') ?? ''
  const signature = request.headers.get('x-quiz-signature') ?? ''
  const seconds = Number(timestamp)
  const raw = await request.text()
  if (!Number.isInteger(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300 || !/^[a-f0-9]{64}$/i.test(signature)) {
    return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 })
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest()
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return NextResponse.json({ error: 'Assinatura inválida' }, { status: 401 })

  let payload: Payload
  try { payload = JSON.parse(raw) as Payload } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }) }
  const { submissionId, contact, answers, result, attribution } = payload
  if (payload.consent !== true) return NextResponse.json({ error: 'Consentimento necessário' }, { status: 400 })
  if (!submissionId || !/^[a-f0-9-]{36}$/i.test(submissionId) || !contact?.name?.trim()) return NextResponse.json({ error: 'Dados de contato inválidos' }, { status: 400 })
  if (!answers || Object.keys(answers).length !== 20 || QUESTIONS.some((key) => !Array.isArray(answers[key]) || answers[key].length === 0)) {
    return NextResponse.json({ error: 'O quiz deve conter as 20 respostas' }, { status: 400 })
  }
  if (!result?.profile || typeof result.score !== 'number' || !result.range) return NextResponse.json({ error: 'Resultado inválido' }, { status: 400 })

  try {
    const schema = sql.raw(`"${SCHEMA}"`)
    await db.execute(sql`
      WITH input AS (
        SELECT ${submissionId}::text AS submission_id,
               ${contact.name.trim()}::text AS display_name,
               ${JSON.stringify(contact)}::jsonb AS contact_data,
               ${JSON.stringify(answers)}::jsonb AS answers,
               ${JSON.stringify(result)}::jsonb AS result,
               ${JSON.stringify(attribution ?? {})}::jsonb AS attribution
      ), existing AS (
        SELECT pf.contact_id
        FROM ${schema}.sac_profile_fields pf, input i
        WHERE pf.tenant_id = ${TENANT} AND pf.agent_id = ${AGENT}
          AND pf.field_name = 'quiz_submission_id' AND pf.source = ${SOURCE}
          AND pf.value = to_jsonb(i.submission_id)
        LIMIT 1
      ), matching_identity AS (
        SELECT cp.contact_id
        FROM ${schema}.sac_contact_points cp, input i
        WHERE cp.tenant_id = ${TENANT} AND cp.agent_id = ${AGENT}
          AND ((NULLIF(i.contact_data->>'phone', '') IS NOT NULL AND cp.kind = 'phone'
                AND cp.normalized_value = regexp_replace(i.contact_data->>'phone', '\\D', '', 'g'))
            OR (NULLIF(i.contact_data->>'email', '') IS NOT NULL AND cp.kind = 'email'
                AND cp.normalized_value = lower(trim(i.contact_data->>'email'))))
        ORDER BY CASE cp.kind WHEN 'phone' THEN 0 ELSE 1 END
        LIMIT 1
      ), chosen AS (
        SELECT COALESCE((SELECT contact_id FROM existing), (SELECT contact_id FROM matching_identity), 'quiz_' || submission_id) AS contact_id FROM input
      ), contact_row AS (
        INSERT INTO ${schema}.sac_contacts AS current_contact (tenant_id, agent_id, id, display_name, metadata)
        SELECT ${TENANT}, ${AGENT}, chosen.contact_id, input.display_name,
               jsonb_build_object('source', ${SOURCE}, 'consent_quiz_answers', true, 'consent_at', clock_timestamp())
        FROM chosen, input
        ON CONFLICT (tenant_id, agent_id, id) DO UPDATE
          SET display_name = EXCLUDED.display_name, updated_at = clock_timestamp(),
              metadata = current_contact.metadata || EXCLUDED.metadata
        RETURNING id
      ), points AS (
        INSERT INTO ${schema}.sac_contact_points
          (tenant_id, agent_id, id, contact_id, kind, value, normalized_value, source)
        SELECT ${TENANT}, ${AGENT}, md5(random()::text || clock_timestamp()::text), contact_row.id,
               p.kind, p.value, p.normalized, ${SOURCE}
        FROM contact_row, input
        CROSS JOIN LATERAL (VALUES
          ('phone', NULLIF(input.contact_data->>'phone', ''), regexp_replace(COALESCE(input.contact_data->>'phone', ''), '\\D', '', 'g')),
          ('email', NULLIF(input.contact_data->>'email', ''), lower(trim(COALESCE(input.contact_data->>'email', ''))))
        ) AS p(kind, value, normalized)
        WHERE p.value IS NOT NULL AND p.normalized <> ''
        ON CONFLICT (tenant_id, agent_id, kind, normalized_value) DO NOTHING
        RETURNING id
      ), tag AS (
        INSERT INTO ${schema}.sac_tags (tenant_id, agent_id, id, name)
        VALUES (${TENANT}, ${AGENT}, 'meta_ads', 'Meta Ads')
        ON CONFLICT (tenant_id, agent_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      ), tagged AS (
        INSERT INTO ${schema}.sac_contact_tags (tenant_id, agent_id, contact_id, tag_id, source)
        SELECT ${TENANT}, ${AGENT}, contact_row.id, tag.id, ${SOURCE} FROM contact_row, tag
        ON CONFLICT (tenant_id, agent_id, contact_id, tag_id) DO NOTHING
        RETURNING contact_id
      ), fields AS (
        SELECT 'quiz_submission_id' AS field_name, to_jsonb(input.submission_id) AS value FROM input
        UNION ALL SELECT 'quiz_result', input.result FROM input
        UNION ALL SELECT 'meta_attribution', input.attribution FROM input
        UNION ALL SELECT 'quiz_contact', input.contact_data FROM input
        UNION ALL SELECT 'quiz_consent', jsonb_build_object(
          'accepted', true,
          'accepted_at', clock_timestamp(),
          'text', 'Concordo que minhas respostas ao quiz sejam armazenadas no SAC da Bella Franklin para personalizar meu resultado e atendimento. Posso solicitar a exclusão dos meus dados.',
          'version', '2026-11-04'
        ) FROM input
        UNION ALL SELECT 'quiz_answer_' || a.key, a.value FROM input CROSS JOIN LATERAL jsonb_each(input.answers) a
      )
      INSERT INTO ${schema}.sac_profile_fields (tenant_id, agent_id, id, contact_id, field_name, value, source)
      SELECT ${TENANT}, ${AGENT}, md5(random()::text || clock_timestamp()::text), contact_row.id, fields.field_name, fields.value, ${SOURCE}
      FROM contact_row CROSS JOIN fields
      ON CONFLICT (tenant_id, agent_id, contact_id, field_name, source)
      DO UPDATE SET value = EXCLUDED.value, observed_at = clock_timestamp()
    `)
    return NextResponse.json({ ok: true, submissionId })
  } catch (error) {
    console.error('[quiz-isabela] Falha ao persistir submissão', error)
    return NextResponse.json({ error: 'Não foi possível salvar as respostas' }, { status: 503 })
  }
}
