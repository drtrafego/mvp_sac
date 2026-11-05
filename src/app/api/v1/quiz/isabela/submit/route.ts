import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'node:crypto'

export const dynamic = 'force-dynamic'
const TENANT = 'isabela-fanini'
const AGENT = 'bela'
const schemaName = (v: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(v)) throw new Error('invalid schema'); return `"${v}"` }
const text = (v: unknown, max = 500) => typeof v === 'string' ? v.trim().slice(0, max) : ''

export async function POST(req: NextRequest) {
  const expected = process.env.ISABELA_QUIZ_API_KEY?.trim()
  const supplied = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!expected || !supplied || supplied !== expected) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || body.tenant !== TENANT || body.agent !== AGENT) return NextResponse.json({ error: 'tenant/agent inválidos' }, { status: 400 })
  const name = text(body.name, 160), phone = text(body.phone, 40).replace(/\D/g, ''), email = text(body.email, 254).toLowerCase()
  const key = text(req.headers.get('idempotency-key') || body.idempotency_key, 200)
  const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers : null
  const result = body.result && typeof body.result === 'object' && !Array.isArray(body.result) ? body.result : null
  if (!name || (!phone && !email) || !key || !answers || Object.keys(answers).length !== 20 || !result || body.consent !== true) return NextResponse.json({ error: 'payload inválido: nome, contato, 20 respostas, resultado, consentimento e idempotency-key são obrigatórios' }, { status: 400 })
  if (Object.values(answers).some(v => !(typeof v === 'string' || typeof v === 'number' || (Array.isArray(v) && v.every(x => typeof x === 'string' || typeof x === 'number'))))) return NextResponse.json({ error: 'respostas inválidas' }, { status: 400 })
  const sql = neon(process.env.DATABASE_URL!)
  const [agent] = await sql`SELECT schema_name FROM public.sac_agents WHERE tenant_id=${TENANT} AND id=${AGENT} AND status IN ('provisioned','active')`
  if (!agent?.schema_name) return NextResponse.json({ error: 'agente não provisionado' }, { status: 503 })
  const s = schemaName(String(agent.schema_name))
  const [existing] = await sql.query(`SELECT id, contact_id FROM ${s}.sac_quiz_isabela_submissions WHERE tenant_id=$1 AND agent_id=$2 AND idempotency_key=$3`, [TENANT, AGENT, key])
  if (existing) return NextResponse.json({ ok: true, reused: true, submission_id: existing.id, contact_id: existing.contact_id }, { status: 200 })
  const [contact] = await sql.query(`SELECT c.id FROM ${s}.sac_contacts c LEFT JOIN ${s}.sac_contact_points p ON p.contact_id=c.id AND p.tenant_id=$1 AND p.agent_id=$2 WHERE c.tenant_id=$1 AND c.agent_id=$2 AND (($3 <> '' AND p.kind='phone' AND p.normalized_value=$3) OR ($4 <> '' AND p.kind='email' AND p.normalized_value=$4)) ORDER BY c.updated_at DESC LIMIT 1`, [TENANT, AGENT, phone, email])
  const contactId = contact?.id || randomUUID()
  const attribution = { tag: 'meta_ads', origin: 'quiz_isabela', ...(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','fbc','fbp'].reduce((a,k) => { const v=text(body[k],500); if(v) a[k]=v; return a }, {} as Record<string,string>)) }
  await sql.query(`INSERT INTO ${s}.sac_contacts (tenant_id,agent_id,id,display_name,metadata) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (tenant_id,agent_id,id) DO UPDATE SET display_name=EXCLUDED.display_name, updated_at=clock_timestamp()`, [TENANT, AGENT, contactId, name, JSON.stringify({source:'quiz_isabela'})])
  for (const [kind, value] of [['phone',phone],['email',email]] as const) if (value) await sql.query(`INSERT INTO ${s}.sac_contact_points (tenant_id,agent_id,id,contact_id,kind,value,normalized_value,source) VALUES ($1,$2,$3,$4,$5,$6,$6,'quiz_isabela') ON CONFLICT (tenant_id,agent_id,kind,normalized_value) DO NOTHING`, [TENANT, AGENT, randomUUID(), contactId, kind, value])
  const consentRecord = { accepted: true, text: 'Concordo que minhas respostas ao quiz sejam armazenadas no SAC da Bella Franklin para personalizar meu resultado e atendimento. Posso solicitar a exclusão dos meus dados.', version: '2026-11-05', accepted_at: new Date().toISOString() }
  for (const [field, value] of [['quiz_answers',answers],['quiz_result',result],['quiz_consent',consentRecord]] as const) await sql.query(`INSERT INTO ${s}.sac_profile_fields (tenant_id,agent_id,id,contact_id,field_name,value,source,observed_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,'quiz_isabela',clock_timestamp()) ON CONFLICT (tenant_id,agent_id,contact_id,field_name,source) DO UPDATE SET value=EXCLUDED.value, observed_at=EXCLUDED.observed_at`, [TENANT, AGENT, randomUUID(), contactId, field, JSON.stringify(value)])
  const [tag] = await sql.query(`INSERT INTO ${s}.sac_tags (tenant_id,agent_id,id,name) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,agent_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [TENANT, AGENT, randomUUID(), 'Meta Ads'])
  await sql.query(`INSERT INTO ${s}.sac_contact_tags (tenant_id,agent_id,contact_id,tag_id,source) VALUES ($1,$2,$3,$4,'quiz_isabela') ON CONFLICT (tenant_id,agent_id,contact_id,tag_id) DO UPDATE SET source=EXCLUDED.source`, [TENANT, AGENT, contactId, tag.id])
  const [submission] = await sql.query(`INSERT INTO ${s}.sac_quiz_isabela_submissions (tenant_id,agent_id,id,contact_id,idempotency_key,answers,result,consent,attribution) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,true,$8::jsonb) RETURNING id,contact_id`, [TENANT, AGENT, randomUUID(), contactId, key, JSON.stringify(answers), JSON.stringify(result), JSON.stringify(attribution)])
  return NextResponse.json({ ok: true, reused: false, submission_id: submission.id, contact_id: submission.contact_id }, { status: 201 })
}
