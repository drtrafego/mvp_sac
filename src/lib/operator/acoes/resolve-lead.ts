import { and, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { inferPipelineStage } from '@/lib/pipeline-stage'
import type { LeadAlvo } from './types'
export async function resolverLead(companyId: number, referencia: string) {
  const ref = referencia.trim()
  const digits = ref.replace(/\D/g, '')
  const byId = /^#\d{1,9}$/.test(ref)
  const byPhone = /^[+\d\s().-]+$/.test(ref)
  const byEmail = ref.includes('@')
  if (byPhone && digits.length < 4) return { tipo: 'incompleto' as const }
  const terms = ref.toLocaleLowerCase('pt-BR').split(/[^\p{L}\p{M}\p{N}_]+/u).filter(Boolean)
  const suffix = digits.slice(-8)
  // Prefixos de palavras podem sugerir candidatos, mas só palavras inteiras
  // permitem executar sem a escolha humana (Ana nunca casa com Mariana).
  const match = byId ? eq(recoveryLeads.id, Number(ref.slice(1)))
    : byPhone ? sql`right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), ${suffix.length}) = ${suffix}`
    : byEmail ? sql`lower(${recoveryLeads.email}) = lower(${ref})`
    : terms.length ? and(...terms.map(t => sql`${recoveryLeads.name} ~* ${'\\m' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)) : sql`false`
  const rows = await db.select({ id: recoveryLeads.id, name: recoveryLeads.name, phone: recoveryLeads.phone, pipelineStage: recoveryLeads.pipelineStage, contextVersion: recoveryLeads.contextVersion, status: recoveryLeads.status, eventType: recoveryLeads.eventType, priority: recoveryLeads.priority })
    .from(recoveryLeads).where(and(eq(recoveryLeads.companyId, companyId), match))
    .orderBy(sql`${recoveryLeads.updatedAt} DESC NULLS LAST`, desc(recoveryLeads.id)).limit(11)
  const leads: LeadAlvo[] = rows.map(l => ({ id: l.id, pipelineStageBruto: l.pipelineStage, etapaEfetiva: inferPipelineStage(l), contextVersion: l.contextVersion ?? 1,
    rotulo: l.name?.trim().split(/\s+/).filter(Boolean).map(w => w.slice(0, 1) + (w.length > 1 ? '***' : '')).join(' ') || 'Sem nome', telefoneFinal: l.phone?.replace(/\D/g, '').slice(-4) || null }))
  if (!leads.length) return { tipo: 'nenhum' as const }
  if (leads.length === 11) return { tipo: 'muitos' as const }
  const words = rows[0]?.name?.toLocaleLowerCase('pt-BR').split(/[^\p{L}\p{M}\p{N}_]+/u) ?? []
  const exact = byId || byPhone || byEmail || terms.every(t => words.includes(t))
  if (leads.length === 1 && exact) return { tipo: 'ok' as const, lead: leads[0] }
  return { tipo: 'esclarecer' as const, candidatos: leads.map(l => ({ leadId: l.id, rotulo: l.rotulo, telefoneFinal: l.telefoneFinal, etapa: l.etapaEfetiva })) }
}
