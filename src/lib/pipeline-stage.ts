// Inferência da etapa do Pipeline quando o lead não tem pipeline_stage
// explícito (nunca setado por nenhum webhook de checkout: Hotmart, Kiwify,
// Greenn e Zouti só gravam eventType/status, não pipeline_stage). Fonte
// única de verdade: antes disso, a MESMA regra existia duplicada em três
// lugares (dashboard, página do Pipeline e API v1 de pipeline) e uma cópia
// (a API v1) tinha ficado pra trás sem o fallback por eventType, jogando
// toda venda aprovada (compra_aprovada) em "novo_contato" em vez de
// "fechado". Qualquer lugar que precise inferir a etapa de um lead deve
// importar daqui, nunca reescrever a regra.
export type PipelineStageInput = {
  pipelineStage?: string | null
  status?: string | null
  eventType?: string | null
  priority?: number | null
}

export function inferPipelineStage(lead: PipelineStageInput): string {
  if (lead.pipelineStage) return lead.pipelineStage
  if (lead.status === 'converted' || lead.eventType === 'compra_aprovada') return 'fechado'
  if (lead.status === 'in_progress') return 'em_atendimento'
  if (lead.eventType === 'pix' || lead.eventType === 'boleto') return 'qualificado'
  if (lead.priority && lead.priority > 1) return 'agendado'
  return 'novo_contato'
}
