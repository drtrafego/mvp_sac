import { and, eq, isNull, lt, ne, sql, inArray } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads, sacPendingItems, sacAuditEvents } from '@/lib/db/schema'

export interface EvaluatePendingRulesOptions {
  companyId: number
  leadId?: number
  now?: Date
}

export interface EvaluatePendingRulesResult {
  retornosVencidosCriados: number
  transbordosCriados: number
  etapasSemRetornoCriadas: number
  itensEncerrados: number
}

// Etapas que por padrão exigem uma data de próximo retorno se ativas
const STAGES_REQUIRING_FOLLOWUP = ['em_atendimento', 'qualificado', 'agendado']

export async function evaluateSacPendingRules(
  options: EvaluatePendingRulesOptions
): Promise<EvaluatePendingRulesResult> {
  const { companyId, leadId } = options
  const now = options.now ?? new Date()

  let retornosVencidosCriados = 0
  let transbordosCriados = 0
  let etapasSemRetornoCriadas = 0
  let itensEncerrados = 0

  // ───────────────────────────────────────────────────────────────────────────
  // REGRA A — Retorno Vencido
  // Condição: followUpDate < now e sacCaseState != 'resolvido'
  // ───────────────────────────────────────────────────────────────────────────
  const whereLeadA = [
    eq(recoveryLeads.companyId, companyId),
    lt(recoveryLeads.followUpDate, now),
    ne(recoveryLeads.sacCaseState, 'resolvido'),
  ]
  if (leadId) whereLeadA.push(eq(recoveryLeads.id, leadId))

  const overdueLeads = await db
    .select({
      id: recoveryLeads.id,
      followUpDate: recoveryLeads.followUpDate,
      followUpNote: recoveryLeads.followUpNote,
      humanOwnerMemberId: recoveryLeads.humanOwnerMemberId,
    })
    .from(recoveryLeads)
    .where(and(...whereLeadA))

  for (const l of overdueLeads) {
    if (!l.followUpDate) continue
    const dateStr = l.followUpDate.toISOString().slice(0, 10)
    const sourceKey = `retorno-${l.id}-${dateStr}`
    const reason = `Retorno agendado para ${dateStr} está vencido. ${l.followUpNote ? `Motivo: ${l.followUpNote}` : 'Sem motivo informado.'}`

    const ownerId = typeof l.humanOwnerMemberId === 'number' ? l.humanOwnerMemberId : null

    const inserted = await db
      .insert(sacPendingItems)
      .values({
        companyId,
        leadId: l.id,
        ruleType: 'retorno_vencido',
        sourceKey,
        reason,
        humanOwnerMemberId: ownerId,
        dueAt: l.followUpDate,
        state: 'pendente',
      })
      .onConflictDoNothing()

    if (inserted) retornosVencidosCriados++
  }

  // Se o lead reagendou para data futura ou concluiu, encerrar alertas antigos de retorno vencido
  const whereCloseA = [
    eq(recoveryLeads.companyId, companyId),
  ]
  if (leadId) whereCloseA.push(eq(recoveryLeads.id, leadId))

  const leadsForCloseA = await db
    .select({
      id: recoveryLeads.id,
      followUpDate: recoveryLeads.followUpDate,
      sacCaseState: recoveryLeads.sacCaseState,
    })
    .from(recoveryLeads)
    .where(and(...whereCloseA))

  for (const l of leadsForCloseA) {
    const isFutureOrEmpty = !l.followUpDate || l.followUpDate >= now
    const isResolved = l.sacCaseState === 'resolvido'

    if (isFutureOrEmpty || isResolved) {
      const closed = await db
        .update(sacPendingItems)
        .set({
          state: 'resolvido',
          resolvedAt: now,
        })
        .where(
          and(
            eq(sacPendingItems.companyId, companyId),
            eq(sacPendingItems.leadId, l.id),
            eq(sacPendingItems.ruleType, 'retorno_vencido'),
            eq(sacPendingItems.state, 'pendente')
          )
        )
        .returning()

      itensEncerrados += closed.length
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // REGRA B — Transbordo sem Dono
  // Condição: sacCaseState == 'transbordo' e humanOwnerMemberId is null
  // ───────────────────────────────────────────────────────────────────────────
  const whereLeadB = [
    eq(recoveryLeads.companyId, companyId),
    eq(recoveryLeads.sacCaseState, 'transbordo'),
    isNull(recoveryLeads.humanOwnerMemberId),
  ]
  if (leadId) whereLeadB.push(eq(recoveryLeads.id, leadId))

  const transbordoLeads = await db
    .select({
      id: recoveryLeads.id,
      botPausedAt: recoveryLeads.botPausedAt,
    })
    .from(recoveryLeads)
    .where(and(...whereLeadB))

  for (const l of transbordoLeads) {
    const sourceKey = `transbordo-${l.id}`
    const reason = 'Solicitação de atendimento humano aguardando um responsável na equipe.'

    const inserted = await db
      .insert(sacPendingItems)
      .values({
        companyId,
        leadId: l.id,
        ruleType: 'transbordo_sem_dono',
        sourceKey,
        reason,
        humanOwnerMemberId: null,
        dueAt: l.botPausedAt ?? now,
        state: 'pendente',
      })
      .onConflictDoNothing()

    if (inserted) transbordosCriados++
  }

  // Se o lead ganhou um dono humano ou foi resolvido, encerrar pendência de transbordo
  if (leadId) {
    const [leadToCheck] = await db
      .select({
        humanOwnerMemberId: recoveryLeads.humanOwnerMemberId,
        sacCaseState: recoveryLeads.sacCaseState,
      })
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, leadId), eq(recoveryLeads.companyId, companyId)))

    if (leadToCheck && (leadToCheck.humanOwnerMemberId || leadToCheck.sacCaseState === 'resolvido')) {
      const closed = await db
        .update(sacPendingItems)
        .set({
          state: 'resolvido',
          resolvedAt: now,
        })
        .where(
          and(
            eq(sacPendingItems.companyId, companyId),
            eq(sacPendingItems.leadId, leadId),
            eq(sacPendingItems.ruleType, 'transbordo_sem_dono'),
            eq(sacPendingItems.state, 'pendente')
          )
        )
        .returning()

      itensEncerrados += closed.length
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // REGRA C — Etapa sem Retorno
  // Condição: lead na etapa qualificado/em_atendimento sem followUpDate
  // ───────────────────────────────────────────────────────────────────────────
  const whereLeadC = [
    eq(recoveryLeads.companyId, companyId),
    isNull(recoveryLeads.followUpDate),
    inArray(recoveryLeads.pipelineStage, STAGES_REQUIRING_FOLLOWUP),
    ne(recoveryLeads.sacCaseState, 'resolvido'),
  ]
  if (leadId) whereLeadC.push(eq(recoveryLeads.id, leadId))

  const etapaSemRetornoLeads = await db
    .select({
      id: recoveryLeads.id,
      pipelineStage: recoveryLeads.pipelineStage,
      humanOwnerMemberId: recoveryLeads.humanOwnerMemberId,
    })
    .from(recoveryLeads)
    .where(and(...whereLeadC))

  for (const l of etapaSemRetornoLeads) {
    const stage = l.pipelineStage || 'etapa'
    const sourceKey = `etapa-sem-retorno-${l.id}-${stage}`
    const reason = `Lead na etapa '${stage}' sem retorno agendado. Sugestão: programar acompanhamento.`

    const ownerId = typeof l.humanOwnerMemberId === 'number' ? l.humanOwnerMemberId : null

    const inserted = await db
      .insert(sacPendingItems)
      .values({
        companyId,
        leadId: l.id,
        ruleType: 'etapa_sem_retorno',
        sourceKey,
        reason,
        humanOwnerMemberId: ownerId,
        dueAt: now,
        state: 'pendente',
      })
      .onConflictDoNothing()

    if (inserted) etapasSemRetornoCriadas++
  }

  return {
    retornosVencidosCriados,
    transbordosCriados,
    etapasSemRetornoCriadas,
    itensEncerrados,
  }
}
