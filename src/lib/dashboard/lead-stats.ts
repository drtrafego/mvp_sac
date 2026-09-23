import { sql, type SQL } from 'drizzle-orm'
import { recoveryLeads, whatsappMessages } from '../db/schema'

export type DashboardBusinessModel = 'gramado' | 'lucas' | 'agencia' | 'infoproduto'

export function gramadoDashboardCardCounts(stats: { fechadosTotal?: number | null } | null | undefined) {
  const businessWon = stats?.fechadosTotal ?? 0

  // O funil executivo do Gramado e cumulativo: uma reserva ganha continua
  // contando em Reserva Confirmada e em Compareceu. A origem historica so
  // consegue materializar esses registros como pipeline_stage='agendado',
  // portanto os dois cards devem consumir a metrica central de negocio ganho.
  return {
    reservaConfirmada: businessWon,
    compareceu: businessWon,
  }
}

const statusLower = sql`lower(coalesce(${recoveryLeads.status}, ''))`
const stageLower = sql`lower(coalesce(${recoveryLeads.pipelineStage}, ''))`
const eventLower = sql`lower(coalesce(${recoveryLeads.eventType}, ''))`

// Subqueries correlacionadas (uma linha por lead, sem join que multiplica
// contagem): usadas para reproduzir o funil de ENGAJAMENTO do painel nativo
// do Hermes ("Responderam", "Avançaram") a partir do historico real de
// mensagens em whatsapp_messages, nunca do status/pipeline_stage do CRM.
const leadRespondedExistsSql = sql`exists (
  select 1 from ${whatsappMessages}
  where ${whatsappMessages.leadId} = ${recoveryLeads.id}
    and ${whatsappMessages.companyId} = ${recoveryLeads.companyId}
    and ${whatsappMessages.direction} = 'inbound'
)`
const leadMessageCountSql = sql`(
  select count(*) from ${whatsappMessages}
  where ${whatsappMessages.leadId} = ${recoveryLeads.id}
    and ${whatsappMessages.companyId} = ${recoveryLeads.companyId}
)`

export function resolveDashboardBusinessModel(slug: string): DashboardBusinessModel {
  if (slug.includes('gramado')) return 'gramado'
  if (slug.includes('lucas')) return 'lucas'
  if (slug.includes('autonomia') || slug.includes('casal') || slug.includes('gastao')) return 'agencia'
  return 'infoproduto'
}

export function dashboardFunnelStageSql(model: DashboardBusinessModel): SQL<string> {
  if (model === 'gramado') {
    return sql<string>`case
      when ${stageLower} in ('compareceu', 'cliente_compareceu') or ${statusLower} in ('compareceu', 'cliente compareceu') or ${eventLower} in ('compareceu') then 'compareceu'
      when ${stageLower} in ('perdido', 'cancelado') or ${statusLower} in ('perdido', 'cancelado') then 'perdido'
      when ${statusLower} in ('reserva confirmada', 'reserva_confirmada', 'completed') or ${stageLower} in ('fechado', 'contrato_fechado', 'reserva_confirmada', 'reserva confirmada', 'agendado', 'reserva_agendada') or ${eventLower} in ('reserva_confirmada', 'reserva confirmada', 'agendado') then 'fechado'
      when ${stageLower} in ('proposta', 'proposta_enviada', 'negociacao', 'cardapio', 'cardapio_pacote') or ${statusLower} in ('cardapio / pacote', 'cardápio / pacote', 'cardapio_pacote') then 'proposta'
      when ${stageLower} in ('qualificado', 'duvida', 'avaliacao', 'data_consultada') or ${statusLower} in ('data consultada', 'data_consultada') then 'qualificado'
      else 'novo_contato'
    end`
  }

  if (model === 'lucas') {
    return sql<string>`case
      when ${stageLower} in ('procedimento_realizado', 'compareceu', 'fechado') or ${statusLower} in ('procedimento realizado', 'procedimento_realizado', 'compareceu') or ${eventLower} in ('procedimento_realizado', 'compareceu') then 'fechado'
      when ${stageLower} in ('perdido', 'cancelado') or ${statusLower} in ('perdido', 'cancelado') then 'perdido'
      when ${stageLower} in ('agendado', 'consulta_agendada', 'reuniao_agendada') or ${statusLower} in ('consulta agendada', 'consulta_agendada', 'agendado') or ${eventLower} in ('agendado', 'agendamento', 'consulta_agendada') then 'agendado'
      when ${stageLower} in ('horario_oferecido', 'horarios_oferecidos', 'proposta') or ${statusLower} in ('horarios oferecidos', 'horários oferecidos', 'horario_oferecido') then 'proposta'
      when ${stageLower} in ('qualificado', 'duvida', 'avaliacao', 'data_consultada') or ${statusLower} in ('duvida de procedimento', 'dúvida de procedimento', 'qualificado') then 'qualificado'
      else 'novo_contato'
    end`
  }

  if (model === 'agencia') {
    return sql<string>`case
      when ${stageLower} in ('perdido', 'cancelado') or ${statusLower} in ('perdido', 'cancelado') then 'perdido'
      when ${stageLower} in ('fechado', 'contrato_fechado') or ${statusLower} in ('converted', 'completed', 'approved', 'contrato fechado') or ${eventLower} in ('compra_aprovada') then 'fechado'
      when ${stageLower} in ('agendado', 'reuniao_agendada', 'consulta_agendada') or ${eventLower} in ('agendado', 'agendamento') then 'agendado'
      when ${stageLower} in ('proposta', 'proposta_enviada', 'negociacao') then 'proposta'
      when ${stageLower} in ('qualificado', 'duvida', 'avaliacao', 'data_consultada', 'em_atendimento') then 'qualificado'
      else 'novo_contato'
    end`
  }

  return sql<string>`case
    when ${stageLower} in ('perdido', 'cancelado') or ${statusLower} in ('perdido', 'cancelado', 'refunded', 'chargedback') then 'perdido'
    when ${stageLower} in ('fechado', 'contrato_fechado') or ${statusLower} in ('converted', 'completed', 'approved') or ${eventLower} in ('compra_aprovada') then 'fechado'
    when ${stageLower} in ('agendado', 'reuniao_agendada', 'consulta_agendada') or ${eventLower} in ('agendado', 'agendamento') then 'agendado'
    when ${stageLower} in ('proposta', 'proposta_enviada', 'negociacao') then 'proposta'
    when ${stageLower} in ('qualificado', 'duvida', 'avaliacao', 'data_consultada', 'em_atendimento') or ${eventLower} in ('pix', 'boleto') then 'qualificado'
    else 'novo_contato'
  end`
}

export function dashboardBusinessWonSql(model: DashboardBusinessModel): SQL {
  const stage = dashboardFunnelStageSql(model)

  if (model === 'gramado') return sql`${stage} in ('fechado', 'compareceu')`
  if (model === 'lucas') return sql`${stage} in ('agendado', 'fechado')`
  if (model === 'agencia') return sql`${stage} in ('agendado', 'fechado')`

  return sql`${statusLower} in ('converted', 'completed', 'approved') or ${eventLower} = 'compra_aprovada' or ${stageLower} in ('fechado', 'contrato_fechado')`
}

export function dashboardLeadStatsSelect(model: DashboardBusinessModel) {
  const stage = dashboardFunnelStageSql(model)
  const won = dashboardBusinessWonSql(model)

  return {
    total: sql<number>`cast(count(*) filter (where ${recoveryLeads.firstContactAt} is not null) as int)`,
    aguardandoAbordagem: sql<number>`cast(count(*) filter (where ${recoveryLeads.firstContactAt} is not null and (${statusLower} in ('pending', 'new', 'aguardando') or ${recoveryLeads.status} is null)) as int)`,

    // Funil de engajamento equivalente ao painel nativo do Hermes: conta pelo
    // historico REAL de mensagens (whatsapp_messages), independente do
    // pipeline_stage do CRM. "Avancou" = 4+ mensagens trocadas na conversa.
    respondeuTotal: sql<number>`cast(count(*) filter (where ${recoveryLeads.firstContactAt} is not null and ${leadRespondedExistsSql}) as int)`,
    avancouTotal: sql<number>`cast(count(*) filter (where ${recoveryLeads.firstContactAt} is not null and ${leadMessageCountSql} >= 4) as int)`,
    fechadosTotal: sql<number>`cast(count(*) filter (where ${won}) as int)`,
    valorFechadoCents: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${won}), 0) as bigint)`,
    qualificadosTotal: sql<number>`cast(count(*) filter (where ${stage} in ('qualificado', 'agendado', 'proposta', 'fechado', 'compareceu')) as int)`,

    novoContato: sql<number>`cast(count(*) filter (where ${stage} = 'novo_contato') as int)`,
    qualificado: sql<number>`cast(count(*) filter (where ${stage} = 'qualificado') as int)`,
    agendado: sql<number>`cast(count(*) filter (where ${stage} = 'agendado') as int)`,
    proposta: sql<number>`cast(count(*) filter (where ${stage} = 'proposta') as int)`,
    fechado: sql<number>`cast(count(*) filter (where ${stage} = 'fechado') as int)`,
    compareceu: sql<number>`cast(count(*) filter (where ${stage} = 'compareceu') as int)`,
    perdido: sql<number>`cast(count(*) filter (where ${stage} = 'perdido') as int)`,

    recoveredCount: sql<number>`cast(count(*) filter (where ${recoveryLeads.firstContactAt} is not null and ${statusLower} = 'converted' and ${recoveryLeads.convertedFrom} like 'msg_%' and ${eventLower} in ('boleto','pix','carrinho_abandonado','cartao_recusado')) as int)`,
    recoveredValueCents: sql<number>`cast(coalesce(sum(${recoveryLeads.productValue}) filter (where ${recoveryLeads.firstContactAt} is not null and ${statusLower} = 'converted' and ${recoveryLeads.convertedFrom} like 'msg_%' and ${eventLower} in ('boleto','pix','carrinho_abandonado','cartao_recusado')), 0) as bigint)`,
    boleto: sql<number>`cast(count(*) filter (where ${recoveryLeads.firstContactAt} is not null and ${eventLower} = 'boleto') as int)`,
    pix: sql<number>`cast(count(*) filter (where ${recoveryLeads.firstContactAt} is not null and ${eventLower} = 'pix') as int)`,
    carrinho: sql<number>`cast(count(*) filter (where ${recoveryLeads.firstContactAt} is not null and ${eventLower} = 'carrinho_abandonado') as int)`,
    cartao: sql<number>`cast(count(*) filter (where ${recoveryLeads.firstContactAt} is not null and ${eventLower} = 'cartao_recusado') as int)`,
    aprovada: sql<number>`cast(count(*) filter (where ${recoveryLeads.firstContactAt} is not null and ${eventLower} = 'compra_aprovada') as int)`,
  }
}
