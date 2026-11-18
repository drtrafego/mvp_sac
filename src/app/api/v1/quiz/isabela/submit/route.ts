import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { companies, recoveryLeads, leadTags, sacInternalNotes } from '@/lib/db/schema'
import { formatBrazilianPhone } from '@/lib/phone'
import { normalizeTag } from '@/lib/lead-tags'
import { getInheritedPauseFields } from '@/lib/bot-pause'

export const dynamic = 'force-dynamic'
const TENANT = 'isabela-fanini'
const AGENT = 'bela'
const PLATFORM = 'quiz'
const EVENT_TYPE = 'quiz_isabela'
const PRODUCT_NAME = 'Quiz Teste dos 3 Passos'
const schemaName = (v: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(v)) throw new Error('invalid schema'); return `"${v}"` }
const text = (v: unknown, max = 500) => typeof v === 'string' ? v.trim().slice(0, max) : ''

// Textos das perguntas do quiz (lp_bella, app/data/quiz-data.ts), para a nota
// interna do lead ficar legível no painel. Id sem texto aparece pelo próprio id.
const QUESTIONS: Record<string, string> = {
  idade: 'Qual a sua idade?',
  momento: 'Como está sua vida amorosa agora?',
  sente: 'Como você se sente na maior parte do tempo nas suas relações?',
  area: 'Em qual área da vida você mais se deixa de lado?',
  cansaco: 'O que mais te cansa hoje?',
  favor: 'Alguém te pede um favor que você não quer fazer. O que acontece dentro de você?',
  msg: 'Ele demora pra responder sua mensagem. Qual é a sua primeira reação?',
  briga: 'Numa discussão, você normalmente...',
  gosta: 'Quando você começa a gostar de alguém, o que acontece com você?',
  trava: 'Quando você pensa em dizer o que realmente quer, o que te trava?',
  medo: 'Qual é o seu maior medo numa relação?',
  frases: 'Quais dessas frases você já disse (ou pensou) este ano?',
  freq: 'Com que frequência você se coloca em último lugar?',
  nao: 'Quando você diz não para alguém, o que sente depois?',
  aceitou: 'Você já aceitou numa relação algo que hoje não aceitaria de jeito nenhum?',
  tentou: 'Você já tentou mudar isso antes?',
  futuro: 'Imagine você daqui a 7 dias, sabendo se posicionar. Qual seria a primeira situação em que você agiria diferente?',
  vida: 'E o que mudaria na sua vida se você não aceitasse mais qualquer coisa?',
  desejo: 'Se você pudesse mudar uma coisa primeiro, seria:',
  pronta: 'O quanto você está pronta pra mudar isso agora?',
}

const ATTRIBUTION_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'fbc', 'fbp', 'referrer', 'landing_page'] as const

function referrerHost(ref: string | undefined): string {
  try { return ref ? new URL(ref).host.replace(/^www\./, '') : '' } catch { return '' }
}

// Origem do lead. A UTM manda: utm_source é usado como veio, sem reclassificar.
// Sem UTM, só o gclid prova anúncio (Google Ads). O fbclid não prova, porque a
// Meta também o coloca em clique orgânico de post e bio. Sem nada, é orgânico
// (com referrer) ou direto.
function resolveOrigin(attr: Record<string, string>): { trackingSource: string; tag: string; label: string } {
  if (attr.utm_source) return { trackingSource: attr.utm_source, tag: attr.utm_source, label: `UTM ${attr.utm_source}` }
  if (attr.gclid || attr.gbraid || attr.wbraid) return { trackingSource: 'google_ads', tag: 'google ads', label: 'Google Ads (gclid, sem UTM)' }
  if (attr.fbclid) return { trackingSource: 'social_sem_utm', tag: 'facebook/instagram sem utm', label: 'Facebook ou Instagram sem UTM (pode ser orgânico ou anúncio)' }
  const host = referrerHost(attr.referrer)
  if (host) return { trackingSource: 'organico', tag: `orgânico ${host}`, label: `Orgânico, veio de ${host}` }
  return { trackingSource: 'direto', tag: 'direto', label: 'Direto (sem UTM e sem referrer)' }
}

function buildNote(answers: Record<string, unknown>, result: Record<string, unknown>, attr: Record<string, string>): string {
  const lines: string[] = ['Respostas do Quiz Teste dos 3 Passos', '']
  if (result.profileName || result.profile) lines.push(`Perfil: ${String(result.profileName ?? result.profile)}`)
  if (result.range) lines.push(`Faixa: ${String(result.range)}`)
  if (result.score != null) lines.push(`Pontuação: ${String(result.score)}`)
  lines.push('')
  for (const [id, value] of Object.entries(answers)) {
    const answer = Array.isArray(value) ? value.map(String).join('; ') : String(value)
    lines.push(`${QUESTIONS[id] ?? id}`)
    lines.push(`R: ${answer || 'sem resposta'}`)
    lines.push('')
  }
  lines.push(`Origem: ${resolveOrigin(attr).label}`)
  const utms = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].filter(k => attr[k]).map(k => `${k}: ${attr[k]}`)
  if (utms.length) lines.push(utms.join(', '))
  if (attr.referrer) lines.push(`Referrer: ${attr.referrer}`)
  if (attr.landing_page) lines.push(`Entrou por: ${attr.landing_page}`)
  return lines.join('\n').trim()
}

export async function POST(req: NextRequest) {
  const expected = process.env.ISABELA_QUIZ_API_KEY?.trim()
  const supplied = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (!expected || !supplied || supplied !== expected) return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body || body.tenant !== TENANT || body.agent !== AGENT) return NextResponse.json({ error: 'tenant/agent inválidos' }, { status: 400 })
  const name = text(body.name, 160), rawPhone = text(body.phone, 40), email = text(body.email, 254).toLowerCase()
  const phone = formatBrazilianPhone(rawPhone)
  const key = text(req.headers.get('idempotency-key') || body.idempotency_key, 200)
  const answers = body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? body.answers as Record<string, unknown> : null
  const result = body.result && typeof body.result === 'object' && !Array.isArray(body.result) ? body.result as Record<string, unknown> : null
  if (!name || (!phone && !email) || !key || !answers || Object.keys(answers).length !== 20 || !result || body.consent !== true) return NextResponse.json({ error: 'payload inválido: nome, contato, 20 respostas, resultado, consentimento e idempotency-key são obrigatórios' }, { status: 400 })
  if (Object.values(answers).some(v => !(typeof v === 'string' || typeof v === 'number' || (Array.isArray(v) && v.every(x => typeof x === 'string' || typeof x === 'number'))))) return NextResponse.json({ error: 'respostas inválidas' }, { status: 400 })

  const attribution = ATTRIBUTION_KEYS.reduce((a, k) => { const v = text(body[k], 500); if (v) a[k] = v; return a }, {} as Record<string, string>)
  const origin = resolveOrigin(attribution)

  // 1) Gravação principal: recovery_leads, a tabela que o painel do SAC lista.
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.slug, TENANT))
  if (!company) return NextResponse.json({ error: 'empresa não encontrada' }, { status: 503 })
  const transactionId = `quiz:${key}`
  const [created] = await db.insert(recoveryLeads).values({
    companyId: company.id,
    platform: PLATFORM,
    eventType: EVENT_TYPE,
    phone,
    name,
    email: email || null,
    productName: PRODUCT_NAME,
    transactionId,
    trackingSource: origin.trackingSource,
    utmMedium: attribution.utm_medium ?? null,
    utmCampaign: attribution.utm_campaign ?? null,
    utmContent: attribution.utm_content ?? null,
    utmTerm: attribution.utm_term ?? null,
    notes: buildNote(answers, result, attribution),
    rawPayload: { answers, result, attribution, consent: true },
    // O aceite do quiz é para guardar as respostas, não é opt-in de WhatsApp.
    whatsappConsentStatus: 'unknown',
    status: 'pending',
    orderDate: new Date(),
    ...(await getInheritedPauseFields(company.id, 'whatsapp')),
  }).onConflictDoNothing({
    target: [recoveryLeads.companyId, recoveryLeads.platform, recoveryLeads.transactionId, recoveryLeads.eventType],
    where: sql`${recoveryLeads.transactionId} is not null`,
  }).returning({ id: recoveryLeads.id })

  let leadId = created?.id
  if (!leadId) {
    const [existing] = await db.select({ id: recoveryLeads.id }).from(recoveryLeads).where(and(
      eq(recoveryLeads.companyId, company.id), eq(recoveryLeads.platform, PLATFORM),
      eq(recoveryLeads.transactionId, transactionId), eq(recoveryLeads.eventType, EVENT_TYPE),
    ))
    if (!existing) return NextResponse.json({ error: 'Não foi possível salvar suas respostas. Tente novamente.' }, { status: 500 })
    leadId = existing.id
  }

  // Tags e nota também rodam no reenvio: o neon-http não tem transação, então
  // um retry completa o que tiver falhado sem duplicar nada.
  const tags = [...new Set(['quiz', `origem: ${origin.tag}`].map(normalizeTag))]
  await db.insert(leadTags).values(tags.map(tag => ({ leadId, tag, createdBy: 'quiz_isabela' }))).onConflictDoNothing()
  const [note] = await db.select({ id: sacInternalNotes.id }).from(sacInternalNotes)
    .where(and(eq(sacInternalNotes.leadId, leadId), eq(sacInternalNotes.authorId, 'quiz_isabela'))).limit(1)
  if (!note) {
    await db.insert(sacInternalNotes).values({
      companyId: company.id, leadId, authorType: 'system', authorId: 'quiz_isabela', authorName: 'Quiz Isabela',
      body: buildNote(answers, result, attribution),
    })
  }
  if (!created) return NextResponse.json({ ok: true, reused: true, lead_id: leadId }, { status: 200 })

  // 2) Cópia no esquema do agente (histórico v2). Falha aqui não perde o lead,
  //    que já está no painel; só registra o erro.
  try {
    const v2 = neon(process.env.DATABASE_URL!)
    const [agent] = await v2`SELECT schema_name FROM public.sac_agents WHERE tenant_id=${TENANT} AND id=${AGENT} AND status IN ('provisioned','active')`
    if (agent?.schema_name) {
      const s = schemaName(String(agent.schema_name))
      const contactId = randomUUID()
      await v2.query(`INSERT INTO ${s}.sac_contacts (tenant_id,agent_id,id,display_name,metadata) VALUES ($1,$2,$3,$4,$5::jsonb)`, [TENANT, AGENT, contactId, name, JSON.stringify({ source: 'quiz_isabela', recovery_lead_id: leadId })])
      await v2.query(`INSERT INTO ${s}.sac_quiz_isabela_submissions (tenant_id,agent_id,id,contact_id,idempotency_key,answers,result,consent,attribution) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,true,$8::jsonb) ON CONFLICT (tenant_id,agent_id,idempotency_key) DO NOTHING`, [TENANT, AGENT, randomUUID(), contactId, key, JSON.stringify(answers), JSON.stringify(result), JSON.stringify(attribution)])
    }
  } catch (error) {
    console.error('[quiz-isabela] cópia v2 falhou, lead já gravado no painel', { leadId, error: error instanceof Error ? error.message : String(error) })
  }

  return NextResponse.json({ ok: true, reused: false, lead_id: leadId }, { status: 201 })
}
