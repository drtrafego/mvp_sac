import { and, eq, sql, isNull, or } from 'drizzle-orm'
import { db } from '@/lib/db'
import { companyMembers, recoveryLeads, settings, whatsappMessages } from '@/lib/db/schema'
import { followupDayToIso } from '@/lib/sac-followup-date'

export class SacInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'SacInputError' }
}

export function isUniqueConstraintError(error: unknown): boolean {
  let current = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if ('code' in current && current.code === '23505') return true
    current = 'cause' in current ? current.cause : null
  }
  return false
}

export function parseSacObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SacInputError('O corpo da requisição deve ser um objeto JSON.')
  return value as Record<string, unknown>
}

export function parsePositiveId(value: unknown, label = 'ID'): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) throw new SacInputError(`${label} inválido.`)
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new SacInputError(`${label} inválido.`)
  return id
}

export function parseExpectedVersion(value: unknown): number {
  if (value === undefined) throw new SacInputError('Informe a versão que está sendo editada.', 428)
  return parsePositiveId(value, 'Versão')
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new SacInputError(`${label} deve ser texto ou nulo.`)
  if (value.length > 64000) throw new SacInputError(`${label} excede o tamanho permitido.`)
  return value.trim() || null
}

export function nullableDate(value: unknown, label: string): Date | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string') throw new SacInputError(`${label} deve ser uma data válida ou nulo.`)
  const calendar = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (calendar) {
    const [, y, m, d] = calendar
    const check = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
    if (check.getUTCFullYear() !== Number(y) || check.getUTCMonth() + 1 !== Number(m) || check.getUTCDate() !== Number(d)) throw new SacInputError(`${label} inválida.`)
  }
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new SacInputError(`${label} inválida.`)
  return date
}

const TEXT_FIELDS = ['requestSummary', 'commitment', 'nextAction', 'followUpNote', 'responsibleAgent', 'notes'] as const
const CONTEXT_FIELDS = [...TEXT_FIELDS, 'requestMessageId', 'humanOwnerMemberId', 'nextActionDueAt', 'followUpDate', 'sacCaseState', 'pipelineStage', 'status']
const CASE_STATES = new Set(['aberto', 'em_atendimento', 'aguardando_retorno', 'transbordo', 'resolvido', 'reaberto'])
const DEFAULT_STAGES = ['novo_contato', 'em_atendimento', 'qualificado', 'agendado', 'compareceu', 'fechado', 'perdido']
const LEGACY_LEAD_STATES = ['pending', 'contacted', 'in_progress', 'converted', 'lost', 'active', 'inactive']

export async function getCompanyPipelineStageIds(companyId: number): Promise<string[]> {
  const [config] = await db.select({ columns: settings.pipelineColumns }).from(settings).where(eq(settings.companyId, companyId)).limit(1)
  const configured = Array.isArray(config?.columns) ? config.columns.flatMap((column: unknown) => column && typeof column === 'object' && 'id' in column && typeof column.id === 'string' ? [column.id] : []) : []
  return configured.length ? configured : DEFAULT_STAGES
}

export function sacEpisodeForState(nextState: string) {
  return sql`coalesce(${recoveryLeads.sacCaseEpisode}, 1) + case when (${recoveryLeads.sacCaseState} = 'resolvido' and ${nextState} <> 'resolvido') or (${nextState} = 'transbordo' and ${recoveryLeads.sacCaseState} is distinct from 'transbordo') then 1 else 0 end`
}

export async function validateSacContextFields(
  body: Record<string, unknown>,
  lead: typeof recoveryLeads.$inferSelect,
): Promise<Partial<Omit<typeof recoveryLeads.$inferInsert, 'sacCaseEpisode'>>> {
  const dirty = body.dirtyFields === undefined ? CONTEXT_FIELDS : body.dirtyFields
  if (!Array.isArray(dirty) || dirty.some((key) => typeof key !== 'string' || !CONTEXT_FIELDS.includes(key))) throw new SacInputError('Lista de campos alterados inválida.')
  const allowed = new Set<string>(dirty as string[])
  const update: Partial<Omit<typeof recoveryLeads.$inferInsert, 'sacCaseEpisode'>> = {}
  for (const key of TEXT_FIELDS) if (allowed.has(key) && body[key] !== undefined) update[key] = nullableText(body[key], key)
  for (const key of ['nextActionDueAt', 'followUpDate'] as const) if (allowed.has(key) && body[key] !== undefined) {
    const value = body[key]
    try {
      update[key] = nullableDate(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? followupDayToIso(value) : value, key)
    } catch (error) {
      if (error instanceof SacInputError) throw error
      throw new SacInputError('Data de retorno inválida.')
    }
  }
  if (allowed.has('humanOwnerMemberId') && body.humanOwnerMemberId !== undefined) {
    const id = body.humanOwnerMemberId === null || body.humanOwnerMemberId === '' ? null : parsePositiveId(body.humanOwnerMemberId, 'Responsável')
    if (id !== null) {
      const [member] = await db.select({ id: companyMembers.id }).from(companyMembers).where(and(eq(companyMembers.id, id), eq(companyMembers.companyId, lead.companyId), eq(companyMembers.status, 'ativo'), sql`${companyMembers.stackAuthUserId} is not null`)).limit(1)
      if (!member) throw new SacInputError('O responsável deve ser um membro ativo desta empresa.')
    }
    update.humanOwnerMemberId = id
  }
  if (allowed.has('requestMessageId') && body.requestMessageId !== undefined) {
    const id = body.requestMessageId === null || body.requestMessageId === '' ? null : parsePositiveId(body.requestMessageId, 'Mensagem de referência')
    if (id !== null) {
      // Legacy unbound messages may belong to the conversation by exact phone.
      // A message already bound to another lead is never a valid reference.
      const [message] = await db.select({ id: whatsappMessages.id }).from(whatsappMessages).where(and(eq(whatsappMessages.id, id), eq(whatsappMessages.companyId, lead.companyId), or(eq(whatsappMessages.leadId, lead.id), and(isNull(whatsappMessages.leadId), eq(whatsappMessages.phone, lead.phone))))).limit(1)
      if (!message) throw new SacInputError('A mensagem de referência deve pertencer a este atendimento.')
    }
    update.requestMessageId = id
  }
  if (allowed.has('sacCaseState') && body.sacCaseState !== undefined) {
    if (typeof body.sacCaseState !== 'string' || !CASE_STATES.has(body.sacCaseState)) throw new SacInputError('Estado de atendimento inválido.')
    update.sacCaseState = body.sacCaseState
  }
  if ((allowed.has('pipelineStage') && body.pipelineStage !== undefined) || (allowed.has('status') && body.status !== undefined)) {
    const stages = await getCompanyPipelineStageIds(lead.companyId)
    if (allowed.has('pipelineStage') && body.pipelineStage !== undefined) {
      if (typeof body.pipelineStage !== 'string' || !stages.includes(body.pipelineStage)) throw new SacInputError('Etapa não existe no pipeline desta empresa.')
      update.pipelineStage = body.pipelineStage
    }
    if (allowed.has('status') && body.status !== undefined) {
      if (body.status === null) update.status = null
      else {
        if (typeof body.status !== 'string' || ![...stages, ...LEGACY_LEAD_STATES, lead.status].includes(body.status)) throw new SacInputError('Status do lead inválido.')
        update.status = body.status
      }
    }
  }
  return update
}
