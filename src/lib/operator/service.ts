import { createHash, randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { isUniqueConstraintError } from '@/lib/sac-access'
import { executeReadAction, type ReadResult } from './actions/read'
import { assertPhaseZeroPlan, type OperatorPlan } from './catalog'
import { createOpenRouterAdapter, type ModelResult, type OperatorModelAdapter } from './model-adapter'
import { redactRequestForCompany, resolvePlanMarkers, type RedactedRequest } from './privacy'
import { sacOperatorCompanySettings, sacOperatorJobs, type OperatorJobStatus } from './schema'

export class OperatorServiceError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'OPERATOR_ERROR') { super(message) }
}
export type OperatorSettings = Pick<typeof sacOperatorCompanySettings.$inferSelect, 'maxJobsPerDay' | 'dailyTokenBudget' | 'allowedActions'>
export type OperatorJob = typeof sacOperatorJobs.$inferSelect
export type OperatorRepository = {
  settings(companyId: number): Promise<OperatorSettings | null>
  existing(companyId: number, idempotencyKey: string): Promise<OperatorJob | null>
  usageToday(companyId: number): Promise<{ jobs: number; tokens: number }>
  create(job: typeof sacOperatorJobs.$inferInsert): Promise<OperatorJob>
  update(companyId: number, id: string, values: Partial<typeof sacOperatorJobs.$inferInsert>): Promise<OperatorJob>
  reserve?: (job: typeof sacOperatorJobs.$inferInsert, reservedTokens: number) => Promise<OperatorJob | null>
  settle?: (companyId: number, id: string, values: Partial<typeof sacOperatorJobs.$inferInsert>, actualTokens: number) => Promise<OperatorJob>
  expireStuck?: (companyId: number, id?: string) => Promise<void>
}

// Reserva pequena: o total definitivo é assentado ao encerrar o job.
const ESTIMATED_TOKENS = 512
const utcToday = sql`(now() AT TIME ZONE 'UTC')::date`
const utcDayStart = sql`date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`

const databaseRepository: OperatorRepository = {
  async settings(companyId) {
    const [row] = await db.select().from(sacOperatorCompanySettings).where(eq(sacOperatorCompanySettings.companyId, companyId)).limit(1)
    return row ?? null
  },
  async existing(companyId, idempotencyKey) {
    const [row] = await db.select().from(sacOperatorJobs).where(and(eq(sacOperatorJobs.companyId, companyId), eq(sacOperatorJobs.idempotencyKey, idempotencyKey))).limit(1)
    return row ?? null
  },
  async usageToday(companyId) {
    const [row] = await db.select({ jobs: sql<number>`cast(count(*) as int)`, tokens: sql<number>`cast(coalesce(sum(${sacOperatorJobs.tokensIn} + ${sacOperatorJobs.tokensOut}), 0) as int)` })
      .from(sacOperatorJobs).where(and(eq(sacOperatorJobs.companyId, companyId), sql`${sacOperatorJobs.createdAt} >= ${utcDayStart}`))
    return { jobs: row?.jobs ?? 0, tokens: row?.tokens ?? 0 }
  },
  async reserve(job, reservedTokens) {
    // Primeiro o INSERT tenta reivindicar a chave. Só a linha realmente criada
    // pode tocar na cota. Se a cota falhar, a linha pendente é limpa logo após
    // esta instrução, sem processar o modelo.
    const result = await db.execute<{ id: string }>(sql`
      WITH new_job AS (
        INSERT INTO sac_operator_jobs (id, company_id, requested_by_user_id, role, request_text, idempotency_key, status, reserved_tokens, tokens_in, tokens_out, created_at, updated_at)
        VALUES (${job.id}::uuid, ${job.companyId}, ${job.requestedByUserId}, ${job.role}, ${job.requestText}, ${job.idempotencyKey}, 'pendente', ${reservedTokens}, 0, 0, ${job.createdAt}, ${job.updatedAt})
        ON CONFLICT (company_id, idempotency_key) DO NOTHING
        RETURNING id
      ), quota AS (
        UPDATE sac_operator_company_settings settings
        SET daily_usage_date = ${utcToday},
            daily_jobs_reserved = CASE WHEN settings.daily_usage_date IS DISTINCT FROM ${utcToday} THEN 1 ELSE settings.daily_jobs_reserved + 1 END,
            daily_tokens_reserved = CASE WHEN settings.daily_usage_date IS DISTINCT FROM ${utcToday} THEN ${reservedTokens} ELSE settings.daily_tokens_reserved + ${reservedTokens} END,
            updated_at = now()
        FROM new_job
        WHERE settings.company_id = ${job.companyId}
          AND (CASE WHEN settings.daily_usage_date IS DISTINCT FROM ${utcToday} THEN 0 ELSE settings.daily_jobs_reserved END) < settings.max_jobs_per_day
          AND (CASE WHEN settings.daily_usage_date IS DISTINCT FROM ${utcToday} THEN 0 ELSE settings.daily_tokens_reserved END) + ${reservedTokens} <= settings.daily_token_budget
        RETURNING settings.company_id
      )
      SELECT new_job.id FROM new_job, quota
    `)
    const id = result.rows[0]?.id
    if (!id) {
      await db.delete(sacOperatorJobs).where(and(eq(sacOperatorJobs.companyId, job.companyId), eq(sacOperatorJobs.id, job.id), eq(sacOperatorJobs.status, 'pendente')))
      return null
    }
    await db.update(sacOperatorJobs).set({ status: 'em_execucao', updatedAt: new Date() })
      .where(and(eq(sacOperatorJobs.companyId, job.companyId), eq(sacOperatorJobs.id, id), eq(sacOperatorJobs.status, 'pendente')))
    const [created] = await db.select().from(sacOperatorJobs).where(and(eq(sacOperatorJobs.companyId, job.companyId), eq(sacOperatorJobs.id, id))).limit(1)
    return created ?? null
  },
  async create(job) {
    try { const [row] = await db.insert(sacOperatorJobs).values(job).returning(); return row }
    catch (error) { if (isUniqueConstraintError(error)) { const prior = await this.existing(job.companyId, job.idempotencyKey); if (prior) return prior }; throw error }
  },
  async update(companyId, id, values) {
    const [row] = await db.update(sacOperatorJobs).set({ ...values, updatedAt: new Date() }).where(and(eq(sacOperatorJobs.companyId, companyId), eq(sacOperatorJobs.id, id))).returning()
    if (!row) throw new OperatorServiceError('Job não encontrado.', 404, 'JOB_NOT_FOUND')
    return row
  },
  async settle(companyId, id, values, actualTokens) {
    const [finished] = await db.update(sacOperatorJobs).set({ ...values, updatedAt: new Date() })
      .where(and(eq(sacOperatorJobs.companyId, companyId), eq(sacOperatorJobs.id, id), eq(sacOperatorJobs.status, 'em_execucao'))).returning()
    if (!finished) throw new OperatorServiceError('Job não encontrado.', 404, 'JOB_NOT_FOUND')
    await db.execute(sql`
      UPDATE sac_operator_company_settings settings
      SET daily_tokens_reserved = CASE
            WHEN settings.daily_usage_date = ${utcToday} AND ${finished.createdAt} >= ${utcDayStart}
              THEN GREATEST(0, settings.daily_tokens_reserved - ${finished.reservedTokens} + ${actualTokens})
            ELSE settings.daily_tokens_reserved END,
          updated_at = now()
      WHERE settings.company_id = ${companyId}
    `)
    return finished
  },
  async expireStuck(companyId, id) {
    await db.execute(sql`
      WITH expired AS (
        UPDATE sac_operator_jobs
        SET status = 'falhou', error_code = 'JOB_TIMEOUT', result_text = 'A consulta expirou e foi encerrada.',
            finished_at = now(), updated_at = now(), tokens_in = 0, tokens_out = 0
        WHERE company_id = ${companyId} AND status IN ('pendente', 'em_execucao')
          AND updated_at < now() - interval '10 minutes'
          ${id ? sql`AND id = ${id}::uuid` : sql``}
        RETURNING reserved_tokens, created_at
      )
      UPDATE sac_operator_company_settings settings
      SET daily_tokens_reserved = CASE WHEN settings.daily_usage_date = ${utcToday}
          THEN GREATEST(0, settings.daily_tokens_reserved - COALESCE((SELECT sum(reserved_tokens)::int FROM expired WHERE created_at >= ${utcDayStart}), 0))
          ELSE settings.daily_tokens_reserved END,
          updated_at = now()
      WHERE settings.company_id = ${companyId} AND EXISTS (SELECT 1 FROM expired)
    `)
  },
}

function resultText(results: ReadResult[]): string {
  if (results.length === 1 && results[0].kind === 'buscar_lead') return 'Busca concluída. Os candidatos estão mascarados na tela.'
  if (results.length === 1 && results[0].kind === 'listar_etapas') return 'Etapas do pipeline carregadas.'
  if (results.length === 1 && results[0].kind === 'listar_regras_instagram') return 'Regras de comentário carregadas.'
  return 'Consulta concluída.'
}
function planHash(plan: OperatorPlan) { return createHash('sha256').update(JSON.stringify(plan)).digest('hex') }
function settledUsage(result: ModelResult) {
  return { tokensIn: Math.max(0, result.usage.inputTokens), tokensOut: Math.max(0, result.usage.outputTokens) }
}

export function createOperatorService(deps: { repository?: OperatorRepository; model?: OperatorModelAdapter; execute?: (companyId: number, action: OperatorPlan['actions'][number]) => Promise<ReadResult>; redact?: (companyId: number, text: string) => Promise<RedactedRequest> } = {}) {
  const repository = deps.repository ?? databaseRepository
  const model = deps.model ?? createOpenRouterAdapter()
  const execute = deps.execute ?? executeReadAction
  const redact = deps.redact ?? redactRequestForCompany
  return {
    async submit(input: { companyId: number; userId: string; role: string; requestText: string; idempotencyKey: string }) {
      const text = input.requestText.trim()
      if (!text || text.length > 4000) throw new OperatorServiceError('O pedido deve ter entre 1 e 4.000 caracteres.', 400, 'INVALID_TEXT')
      await repository.expireStuck?.(input.companyId)
      const existing = await repository.existing(input.companyId, input.idempotencyKey)
      if (existing) return { job: existing, reused: true }
      const settings = await repository.settings(input.companyId)
      if (!settings) throw new OperatorServiceError('Empresa sem configuração do Operador SAC.', 403, 'DISABLED')
      const redacted = await redact(input.companyId, text)
      const now = new Date(); const id = randomUUID()
      const reservedTokens = Math.min(ESTIMATED_TOKENS, settings.dailyTokenBudget)
      const draft = { id, companyId: input.companyId, requestedByUserId: input.userId, role: input.role, requestText: redacted.text, idempotencyKey: input.idempotencyKey, status: 'em_execucao' as const, reservedTokens, tokensIn: 0, tokensOut: 0, createdAt: now, updatedAt: now }
      let created: OperatorJob | null
      if (repository.reserve) {
        created = await repository.reserve(draft, reservedTokens)
        if (!created) {
          const duplicate = await repository.existing(input.companyId, input.idempotencyKey)
          if (duplicate) return { job: duplicate, reused: true }
          const usage = await repository.usageToday(input.companyId)
          throw new OperatorServiceError(usage.jobs >= settings.maxJobsPerDay ? 'Limite diário de pedidos atingido.' : 'Orçamento diário de tokens atingido.', 429, usage.jobs >= settings.maxJobsPerDay ? 'DAILY_JOBS_LIMIT' : 'DAILY_TOKEN_BUDGET')
        }
      } else {
        const usage = await repository.usageToday(input.companyId)
        if (usage.jobs >= settings.maxJobsPerDay) throw new OperatorServiceError('Limite diário de pedidos atingido.', 429, 'DAILY_JOBS_LIMIT')
        if (usage.tokens + reservedTokens > settings.dailyTokenBudget) throw new OperatorServiceError('Orçamento diário de tokens atingido.', 429, 'DAILY_TOKEN_BUDGET')
        created = await repository.create(draft)
      }
      if (created.id !== id) return { job: created, reused: true }
      let modelResult: ModelResult | undefined
      try {
        modelResult = await model.plan(redacted.text, Math.min(1200, reservedTokens))
        const safePlan = assertPhaseZeroPlan(modelResult.plan)
        const resolvedPlan = resolvePlanMarkers(safePlan, redacted.markers)
        if (safePlan.actions.some(action => !settings.allowedActions.includes(action.type))) throw new OperatorServiceError('Ação não autorizada para esta empresa.', 403, 'ACTION_NOT_ALLOWED')
        // O plano persistido preserva marcadores; só a chamada de leitura recebe
        // o valor resolvido, dentro deste processo e escopada à empresa.
        const results = await Promise.all(resolvedPlan.actions.map(action => execute(input.companyId, action)))
        const values = { status: 'concluido' as const, planJson: safePlan, planHash: planHash(safePlan), resultText: resultText(results), resultJson: { results }, ...settledUsage(modelResult), model: modelResult.model, finishedAt: new Date() }
        const finished = repository.settle
          ? await repository.settle(input.companyId, id, values, values.tokensIn + values.tokensOut)
          : await repository.update(input.companyId, id, values)
        return { job: finished, reused: false }
      } catch (error) {
        const safe = error instanceof OperatorServiceError ? error : new OperatorServiceError('Não foi possível concluir a consulta.', 502, 'MODEL_OR_READ_FAILURE')
        const usage = modelResult ? settledUsage(modelResult) : { tokensIn: 0, tokensOut: 0 }
        const values = { status: 'falhou' as const, errorCode: safe.code, resultText: safe.message, ...usage, finishedAt: new Date() }
        const failed = repository.settle
          ? await repository.settle(input.companyId, id, values, usage.tokensIn + usage.tokensOut)
          : await repository.update(input.companyId, id, values)
        if (error instanceof OperatorServiceError) throw Object.assign(error, { job: failed })
        return { job: failed, reused: false }
      }
    },
  async expireStuck(companyId: number, id?: string) {
    await repository.expireStuck?.(companyId, id)
  }
}
}

export function isTerminalStatus(status: OperatorJobStatus) { return status === 'concluido' || status === 'falhou' || status === 'cancelado' }
