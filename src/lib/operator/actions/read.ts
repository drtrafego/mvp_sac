import { and, asc, desc, eq, ilike, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { instagramCommentAutomations, recoveryLeads } from '@/lib/db/schema'
import { getCompanyPipelineStageIds } from '@/lib/sac-access'
import type { OperatorPlan } from '../catalog'

export type MaskedLead = { id: number; nome: string; telefone: string | null; email: string | null; etapa: string | null }
export type ReadResult = { kind: string; data: unknown }

function maskName(name: string | null): string {
  if (!name) return 'Sem nome'
  const words = name.trim().split(/\s+/).filter(Boolean)
  return words.map(word => `${word.slice(0, 1)}${word.length > 1 ? '***' : ''}`).join(' ')
}
function maskPhone(phone: string | null): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***'
}
function maskEmail(email: string | null): string | null {
  if (!email) return null
  const [local, domain] = email.split('@')
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***'
}

export async function buscarLeadMascarado(companyId: number, query: string): Promise<MaskedLead[]> {
  const text = query.trim().slice(0, 200)
  if (!text) return []
  // O modelo nunca recebe estes termos. Cada token real é aplicado somente na
  // consulta da empresa corrente, preservando o índice/ILIKE e a ordenação.
  const terms = [...new Set(text.split(/[\s,;]+/).map(term => term.trim()).filter(Boolean))].slice(0, 12)
  if (!terms.length) return []
  const matches = terms.map(term => {
    const pattern = `%${term.replace(/[\\%_]/g, '\\$&')}%`
    return or(ilike(recoveryLeads.name, pattern), ilike(recoveryLeads.phone, pattern), ilike(recoveryLeads.email, pattern))
  })
  const leads = await db.select({ id: recoveryLeads.id, name: recoveryLeads.name, phone: recoveryLeads.phone, email: recoveryLeads.email, pipelineStage: recoveryLeads.pipelineStage })
    .from(recoveryLeads)
    .where(and(eq(recoveryLeads.companyId, companyId), ...matches))
    .orderBy(desc(recoveryLeads.createdAt)).limit(10)
  return leads.map(lead => ({ id: lead.id, nome: maskName(lead.name), telefone: maskPhone(lead.phone), email: maskEmail(lead.email), etapa: lead.pipelineStage }))
}

export async function listarEtapas(companyId: number): Promise<string[]> {
  return getCompanyPipelineStageIds(companyId)
}

export async function listarRegrasInstagram(companyId: number) {
  const rules = await db.select({ id: instagramCommentAutomations.id, name: instagramCommentAutomations.name, keywords: instagramCommentAutomations.keywords, matchType: instagramCommentAutomations.matchType, triggerType: instagramCommentAutomations.triggerType, isActive: instagramCommentAutomations.isActive, mediaId: instagramCommentAutomations.mediaId })
    .from(instagramCommentAutomations).where(eq(instagramCommentAutomations.companyId, companyId)).orderBy(asc(instagramCommentAutomations.name)).limit(100)
  return rules.map(rule => ({ ...rule, keywords: rule.keywords?.slice(0, 160) ?? null }))
}

export async function executeReadAction(companyId: number, action: OperatorPlan['actions'][number]): Promise<ReadResult> {
  switch (action.type) {
    case 'buscar_lead': return { kind: action.type, data: await buscarLeadMascarado(companyId, action.query) }
    case 'listar_etapas': return { kind: action.type, data: await listarEtapas(companyId) }
    case 'listar_regras_instagram': return { kind: action.type, data: await listarRegrasInstagram(companyId) }
    default: throw new Error('Ação não permitida na Fase 0.')
  }
}
