// Estas tabelas vivem exclusivamente em drizzle/0044_sac_operator.sql. Não use
// db:push: schema.ts legado não as inclui e poderia propor removê-las.
import { date, index, integer, jsonb, pgTable, text, timestamp, unique, uuid, boolean } from 'drizzle-orm/pg-core'

export const operatorJobStatuses = ['pendente', 'em_execucao', 'aguardando_confirmacao', 'concluido', 'falhou', 'cancelado'] as const
export type OperatorJobStatus = typeof operatorJobStatuses[number]

export const sacOperatorCompanySettings = pgTable('sac_operator_company_settings', {
  companyId: integer('company_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  killSwitch: boolean('kill_switch').notNull().default(false),
  allowedActions: jsonb('allowed_actions').$type<string[]>().notNull(),
  linkDomains: jsonb('link_domains').$type<string[]>().notNull(),
  stageAliases: jsonb('stage_aliases').$type<Record<string, string>>().notNull(),
  maxJobsPerDay: integer('max_jobs_per_day').notNull(),
  dailyTokenBudget: integer('daily_token_budget').notNull(),
  dailyUsageDate: date('daily_usage_date'),
  dailyJobsReserved: integer('daily_jobs_reserved').notNull().default(0),
  dailyTokensReserved: integer('daily_tokens_reserved').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const sacOperatorJobs = pgTable('sac_operator_jobs', {
  id: uuid('id').primaryKey(),
  companyId: integer('company_id').notNull(),
  requestedByUserId: text('requested_by_user_id').notNull(),
  role: text('role').notNull(),
  requestText: text('request_text').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  status: text('status').$type<OperatorJobStatus>().notNull().default('pendente'),
  waitingReason: text('waiting_reason'),
  planJson: jsonb('plan_json'),
  planHash: text('plan_hash'),
  approvedPlanHash: text('approved_plan_hash'),
  confirmedBy: text('confirmed_by'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  confirmationExpiresAt: timestamp('confirmation_expires_at', { withTimezone: true }),
  resultText: text('result_text'),
  resultJson: jsonb('result_json'),
  errorCode: text('error_code'),
  reservedTokens: integer('reserved_tokens').notNull().default(0),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  model: text('model'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, table => [
  unique('sac_operator_jobs_company_idempotency_unique').on(table.companyId, table.idempotencyKey),
  index('sac_operator_jobs_company_created_idx').on(table.companyId, table.createdAt),
  index('sac_operator_jobs_company_status_idx').on(table.companyId, table.status, table.updatedAt),
])

export const sacOperatorActions = pgTable('sac_operator_actions', {
  id: uuid('id').primaryKey(),
  companyId: integer('company_id').notNull(),
  jobId: uuid('job_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  actionType: text('action_type').notNull(),
  targetId: text('target_id'),
  requestJson: jsonb('request_json').notNull(),
  beforeSnapshot: jsonb('before_snapshot'),
  afterSnapshot: jsonb('after_snapshot'),
  status: text('status').$type<OperatorJobStatus>().notNull().default('pendente'),
  idempotencyKey: text('idempotency_key').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
}, table => [
  unique('sac_operator_actions_company_idempotency_unique').on(table.companyId, table.idempotencyKey),
  unique('sac_operator_actions_job_ordinal_unique').on(table.jobId, table.ordinal),
  index('sac_operator_actions_company_job_idx').on(table.companyId, table.jobId, table.ordinal),
])
