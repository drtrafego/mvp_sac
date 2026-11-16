import 'server-only'
import { randomBytes } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@/lib/db'
import { acoesPlanSchema } from '../acoes/catalog'
import { ACOES_SYSTEM_PROMPT } from '../acoes/prompt'
import { resolverMarcadores } from '../acoes/markers'
import { postgresCode } from '../acoes/sql'
import { aplicarPlanoDoModelo, databaseRepository, OperatorServiceError, type OperatorJob } from '../service'
import { ExecutorError, tokenHash, type Executor } from './auth'
import { executorModelSchema, type ClaimBody, type ClaimResponse, type CompleteBody, type CompleteResponse, type FailBody } from './contract'
import { operatorOutputSchema } from './output-schema'

type QueueRow = { job_id: string; company_id: number; estado: string; lease_epoch: number; lease_expira_em: string; expira_em: string; erro_codigo: string | null }
type Lease = { executor: Executor; jobId: string; companyId: number; epoch: number; token: string }
const utcDay = sql`(now() AT TIME ZONE 'UTC')::date`
const utcStart = sql`date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
const timeoutText = 'O executor não respondeu a tempo. Nada foi alterado. Envie de novo.'

// Todas as mutações de job, cota e privados seguem a empresa da linha ganha.
// O estado aplicando é reconciliado pelo expireStuck existente, nunca refeito.
function terminalEffects(companyId: number): SQL {
  return sql`, ended_jobs AS (
    UPDATE sac_operator_jobs j SET status = 'falhou', error_code = q.erro_codigo,
      result_text = ${timeoutText}, tokens_in = 0, tokens_out = 0, finished_at = now(), updated_at = now()
    FROM changed q WHERE j.id = q.job_id AND j.company_id = ${companyId} AND j.company_id = q.company_id
      AND j.status = 'em_execucao' AND q.estado IN ('falhou','expirado','cancelado') AND q.erro_codigo <> 'APPLICATION_TIMEOUT'
    RETURNING j.reserved_tokens, j.created_at
  ), quota AS (
    UPDATE sac_operator_company_settings s SET daily_tokens_reserved = CASE WHEN s.daily_usage_date = ${utcDay}
      THEN greatest(0, s.daily_tokens_reserved - coalesce((SELECT sum(reserved_tokens)::int FROM ended_jobs WHERE created_at >= ${utcStart}), 0)) ELSE s.daily_tokens_reserved END, updated_at = now()
    WHERE s.company_id = ${companyId} AND EXISTS (SELECT 1 FROM ended_jobs) RETURNING s.company_id
  ), deleted AS (
    DELETE FROM sac_operator_job_privados p WHERE p.company_id = ${companyId}
      AND (p.apagar_apos <= now() OR EXISTS (SELECT 1 FROM changed q WHERE q.job_id = p.job_id AND q.company_id = p.company_id AND q.estado IN ('falhou','expirado','cancelado')))
    RETURNING p.job_id
  )`
}
// A versão no UPDATE evita contar uma fotografia anterior ao enqueue de
// outra conexão que acabou de liberar a linha. Contenção repete com novo snapshot.
export async function enfileirar(job: OperatorJob, privateData: Record<string, unknown>) {
  for (let attempt = 0; attempt < 10; attempt++) {
  const result = await db.execute<{ job_id: string | null; held: boolean }>(sql`WITH version AS MATERIALIZED (
    SELECT updated_at FROM sac_operator_company_settings WHERE company_id = ${job.companyId}
  ), guard AS (
    UPDATE sac_operator_company_settings s SET updated_at = greatest(clock_timestamp(), s.updated_at + interval '1 microsecond')
    WHERE s.company_id = ${job.companyId} AND s.enabled AND NOT s.kill_switch
      AND s.updated_at = (SELECT updated_at FROM version) RETURNING s.company_id
  ), candidate AS (
    SELECT j.id, j.company_id, CASE WHEN j.role = 'platform_admin' THEN 'plataforma'
      WHEN EXISTS (SELECT 1 FROM companies c WHERE c.id = j.company_id AND c.stack_auth_user_id = j.requested_by_user_id) THEN 'dono'
      ELSE 'membro' END AS origin
    FROM sac_operator_jobs j, guard g WHERE j.id = ${job.id}::uuid AND j.company_id = ${job.companyId} AND j.company_id = g.company_id AND j.status = 'em_execucao'
      AND (j.role = 'platform_admin' OR EXISTS (SELECT 1 FROM companies c WHERE c.id = j.company_id AND c.stack_auth_user_id = j.requested_by_user_id)
        OR EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = j.company_id AND m.stack_auth_user_id = j.requested_by_user_id AND m.status = 'ativo' AND m.role = 'admin'))
      AND (SELECT count(*) FROM sac_operator_queue q WHERE q.company_id = ${job.companyId} AND q.estado IN ('na_fila','reclamado','aplicando')) < 5
  ), queued AS (
    INSERT INTO sac_operator_queue (job_id, company_id, expira_em)
    SELECT id, company_id, now() + interval '5 minutes' FROM candidate ON CONFLICT (job_id) DO NOTHING RETURNING job_id, company_id, expira_em
  ), private_insert AS (
    INSERT INTO sac_operator_job_privados
    SELECT p.* FROM queued q JOIN candidate c ON c.id = q.job_id AND c.company_id = q.company_id,
      LATERAL jsonb_populate_record(NULL::sac_operator_job_privados,
        ${JSON.stringify(privateData)}::jsonb || jsonb_build_object('admin_origem', c.origin, 'apagar_apos', q.expira_em)) p
    WHERE p.company_id = ${job.companyId} AND p.company_id = q.company_id AND p.job_id = q.job_id RETURNING job_id
  ) SELECT (SELECT job_id FROM queued) AS job_id, EXISTS (SELECT 1 FROM guard) AS held,
    1 / CASE WHEN (SELECT count(*) FROM queued) = (SELECT count(*) FROM private_insert) THEN 1 ELSE 0 END AS checked`)
  if (result.rows[0]?.job_id) return
  if (result.rows[0]?.held) break
  await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new ExecutorError(429, 'FILA_CHEIA')
}
export async function varrer(companyId: number) {
  await db.execute(sql`WITH changed AS (
    UPDATE sac_operator_queue q SET
      estado = CASE WHEN q.estado = 'aplicando' THEN 'falhou'
        WHEN q.expira_em <= now() THEN 'expirado'
        WHEN j.status <> 'em_execucao' THEN 'cancelado'
        WHEN s.enabled AND NOT s.kill_switch AND q.tentativas < q.max_tentativas AND q.expira_em > now() + interval '90 seconds' THEN 'na_fila' ELSE 'falhou' END,
      erro_codigo = CASE WHEN q.estado = 'aplicando' THEN 'APPLICATION_TIMEOUT'
        WHEN NOT s.enabled OR s.kill_switch THEN 'EXECUTOR_DISABLED' ELSE 'EXECUTOR_TIMEOUT' END,
      disponivel_em = now() + interval '3 seconds', lease_expira_em = NULL, updated_at = now()
    FROM sac_operator_jobs j, sac_operator_company_settings s
    WHERE q.company_id = ${companyId} AND j.company_id = q.company_id AND j.id = q.job_id AND s.company_id = q.company_id
      AND ((q.estado IN ('na_fila','reclamado') AND (q.expira_em <= now() OR j.status <> 'em_execucao' OR NOT s.enabled OR s.kill_switch OR (q.estado = 'reclamado' AND q.lease_expira_em <= now())))
        OR (q.estado = 'aplicando' AND q.updated_at < now() - interval '2 minutes'))
    RETURNING q.*
  ) ${terminalEffects(companyId)} SELECT job_id FROM changed`)
}
export async function reclamar(executor: Executor, body: ClaimBody, idleSince?: (since: number) => void): Promise<ClaimResponse | null> {
  const token = randomBytes(32).toString('base64url')
  const model = executorModelSchema.parse(process.env.OPERATOR_EXECUTOR_MODEL ?? 'gpt-5.6-luna')
  try {
    const result = await db.execute<QueueRow & { pedido: string; manutencao: number[]; ocioso_desde: string }>(sql`WITH version AS MATERIALIZED (SELECT updated_at FROM sac_operator_executors WHERE id = ${executor.id}::uuid), valid_executor AS MATERIALIZED (
      SELECT e.id, e.empresas_permitidas FROM sac_operator_executors e WHERE e.id = ${executor.id}::uuid AND e.revogado_em IS NULL
        AND e.updated_at = (SELECT updated_at FROM version) FOR UPDATE SKIP LOCKED
    ), candidate AS (
      SELECT q.job_id, q.company_id, j.request_text FROM sac_operator_queue q
      JOIN sac_operator_jobs j ON j.id = q.job_id AND j.company_id = q.company_id
      JOIN sac_operator_company_settings s ON s.company_id = q.company_id CROSS JOIN valid_executor e
      WHERE ${body.estado} = 'pronto' AND q.estado = 'na_fila' AND q.disponivel_em <= now() AND q.expira_em > now() + interval '60 seconds'
        AND e.empresas_permitidas @> jsonb_build_array(q.company_id)
        AND s.enabled AND NOT s.kill_switch AND j.status = 'em_execucao' AND q.tentativas < q.max_tentativas
        AND NOT EXISTS (SELECT 1 FROM sac_operator_queue busy WHERE busy.company_id = q.company_id AND busy.estado IN ('reclamado','aplicando'))
        AND (SELECT count(*) FROM sac_operator_queue busy WHERE busy.executor_id = e.id AND busy.estado IN ('reclamado','aplicando')) < 2
      ORDER BY q.created_at, q.job_id LIMIT 1 FOR UPDATE OF q SKIP LOCKED
    ), contact AS (
      UPDATE sac_operator_executors e SET ultimo_contato_em = now(), estado_informado = ${body.estado}, motivo = ${body.motivo ?? null}, versao = ${body.versao}, updated_at = greatest(clock_timestamp(), e.updated_at + interval '1 microsecond')
      FROM valid_executor v WHERE e.id = v.id AND e.revogado_em IS NULL
        AND (e.ultimo_contato_em IS NULL OR e.ultimo_contato_em <= now() - interval '15 seconds'
          OR e.estado_informado IS DISTINCT FROM ${body.estado} OR e.motivo IS DISTINCT FROM ${body.motivo ?? null}
          OR EXISTS (SELECT 1 FROM candidate))
      RETURNING e.id, e.empresas_permitidas
    ), claimed AS (
      UPDATE sac_operator_queue q SET estado = 'reclamado', tentativas = q.tentativas + 1,
        executor_id = ${executor.id}::uuid, lease_epoch = q.lease_epoch + 1, lease_token_hash = ${tokenHash(token)},
        lease_expira_em = least(now() + interval '45 seconds', q.expira_em), heartbeat_em = now(), reclamado_em = now(), updated_at = now()
      FROM candidate c WHERE q.job_id = c.job_id AND q.company_id = c.company_id AND q.estado = 'na_fila'
      RETURNING q.*, c.request_text AS pedido
    ) SELECT c.*, ARRAY(
      SELECT DISTINCT q.company_id FROM sac_operator_queue q, valid_executor e
      WHERE e.empresas_permitidas @> jsonb_build_array(q.company_id)
        AND ((q.estado IN ('na_fila','reclamado') AND (q.expira_em <= now() OR (q.estado = 'reclamado' AND q.lease_expira_em <= now())))
          OR (q.estado = 'aplicando' AND q.updated_at < now() - interval '2 minutes'))
    ) AS manutencao,
      coalesce((SELECT max(q.reclamado_em) FROM sac_operator_queue q WHERE q.executor_id = ${executor.id}::uuid),
        (SELECT e.created_at FROM sac_operator_executors e WHERE e.id = ${executor.id}::uuid)) AS ocioso_desde
    FROM (SELECT 1) singleton LEFT JOIN claimed c ON true`)
    const row = result.rows[0]
    // Fila vazia custa só a instrução acima. Varreduras ocorrem apenas quando
    // há trabalho vencido a reconciliar, usando o escopo lido do banco.
    for (const company of row?.manutencao ?? []) await varrer(company)
    if (!row?.job_id && row?.ocioso_desde) idleSince?.(new Date(row.ocioso_desde).getTime())
    return row?.job_id ? { jobId: row.job_id, leaseToken: token, epoch: row.lease_epoch, leaseExpiraEm: new Date(row.lease_expira_em).toISOString(), prazo: new Date(row.expira_em).toISOString(), modelo: model, sistema: ACOES_SYSTEM_PROMPT, pedido: row.pedido, schema: operatorOutputSchema as Record<string, unknown> } : null
  } catch (error) { if (postgresCode(error) === '23505') return null; throw error }
}
export async function jobScope(executor: Executor, jobId: string): Promise<number> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) throw new ExecutorError(404, 'NOT_FOUND')
  const result = await db.execute<{ company_id: number }>(sql`SELECT q.company_id FROM sac_operator_queue q JOIN sac_operator_executors e ON e.id = ${executor.id}::uuid
    WHERE q.job_id = ${jobId}::uuid AND e.revogado_em IS NULL AND e.empresas_permitidas @> jsonb_build_array(q.company_id)`)
  if (!result.rows[0]) throw new ExecutorError(404, 'NOT_FOUND')
  return result.rows[0].company_id
}
function holder(l: Lease): SQL {
  return sql`q.job_id = ${l.jobId}::uuid AND q.company_id = ${l.companyId} AND q.executor_id = ${l.executor.id}::uuid
    AND q.lease_epoch = ${l.epoch} AND q.lease_token_hash = ${tokenHash(l.token)}
    AND EXISTS (SELECT 1 FROM sac_operator_executors e WHERE e.id = q.executor_id AND e.revogado_em IS NULL AND e.empresas_permitidas @> jsonb_build_array(q.company_id))`
}
function liveLease(l: Lease): SQL { return sql`${holder(l)} AND q.lease_expira_em > now() AND q.expira_em > now()` }
function enabledJob(): SQL { return sql`EXISTS (SELECT 1 FROM sac_operator_company_settings s JOIN sac_operator_jobs j ON j.company_id = s.company_id
  WHERE s.company_id = q.company_id AND s.enabled AND NOT s.kill_switch AND j.id = q.job_id AND j.status = 'em_execucao')` }
export async function heartbeat(l: Lease) {
  const result = await db.execute<{ continuar: boolean }>(sql`WITH owned AS (UPDATE sac_operator_queue q SET heartbeat_em = now(), updated_at = now(),
    lease_expira_em = CASE WHEN ${enabledJob()} THEN least(now() + interval '45 seconds', q.expira_em) ELSE q.lease_expira_em END
    WHERE ${liveLease(l)} AND q.estado = 'reclamado' RETURNING q.executor_id, ${enabledJob()} AS continuar
  ), contact AS (
    UPDATE sac_operator_executors e SET ultimo_contato_em = now(), updated_at = greatest(clock_timestamp(), e.updated_at + interval '1 microsecond')
    FROM owned o WHERE e.id = o.executor_id AND e.revogado_em IS NULL RETURNING e.id
  ) SELECT continuar FROM owned`)
  if (!result.rows[0]) throw new ExecutorError(409, 'LEASE_CONFLICT')
  if (!result.rows[0].continuar) await varrer(l.companyId)
  return result.rows[0]
}
export async function falhar(l: Lease, body: FailBody) {
  const retryable = ['MODEL_TIMEOUT', 'CLI_ERROR', 'MODEL_INVALID_OUTPUT'].includes(body.codigo)
  const result = await db.execute<{ estado: 'na_fila' | 'falhou' }>(sql`WITH changed AS (
    UPDATE sac_operator_queue q SET estado = CASE WHEN ${retryable} AND q.tentativas < q.max_tentativas
      AND q.expira_em > now() + interval '90 seconds' AND ${enabledJob()} THEN 'na_fila' ELSE 'falhou' END,
      erro_codigo = ${'EXECUTOR_' + body.codigo}, disponivel_em = now() + interval '3 seconds', lease_expira_em = NULL, updated_at = now()
    WHERE ${liveLease(l)} AND q.estado = 'reclamado' RETURNING q.*
  ) ${terminalEffects(l.companyId)} SELECT estado FROM changed`)
  if (!result.rows[0]) throw new ExecutorError(409, 'LEASE_CONFLICT')
  return result.rows[0]
}
export async function concluirCAS(l: Lease) {
  const result = await db.execute<QueueRow>(sql`UPDATE sac_operator_queue q SET estado = 'aplicando', updated_at = now()
    WHERE ${liveLease(l)} AND q.estado = 'reclamado' AND ${enabledJob()} RETURNING q.*`)
  return result.rows[0] ?? null
}
export async function completar(l: Lease, body: CompleteBody): Promise<CompleteResponse> {
  const claimed = await concluirCAS(l)
  if (!claimed) {
    const replay = await db.execute<{ erro_codigo: string | null }>(sql`SELECT q.erro_codigo FROM sac_operator_queue q WHERE ${holder(l)} AND q.estado = 'entregue'`)
    if (replay.rows[0]) return savedResponse(replay.rows[0].erro_codigo)
    await varrer(l.companyId)
    throw new ExecutorError(409, 'LEASE_CONFLICT')
  }
  const inputTokens = body.uso.entrada - body.uso.cache
  let code: string | null = null
  try {
    const parsed = acoesPlanSchema.safeParse(body.plano)
    if (!parsed.success) throw new ExecutorError(400, 'INVALID_PLAN')
    const { rows } = await db.execute<{ marcadores: Record<string, string>; texto_original: string; ator_nome: string; requested_by_user_id: string; role: string }>(sql`
      SELECT p.marcadores, p.texto_original, p.ator_nome, j.requested_by_user_id, j.role
      FROM sac_operator_job_privados p JOIN sac_operator_queue q ON q.job_id = p.job_id AND q.company_id = p.company_id
      JOIN sac_operator_jobs j ON j.id = q.job_id AND j.company_id = q.company_id
      WHERE ${liveLease(l)} AND q.estado = 'aplicando' AND p.company_id = ${l.companyId} AND p.apagar_apos > now()
        AND ((p.admin_origem = 'plataforma' AND j.role = 'platform_admin')
          OR EXISTS (SELECT 1 FROM companies c WHERE c.id = q.company_id AND c.stack_auth_user_id = j.requested_by_user_id)
          OR EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = q.company_id AND m.stack_auth_user_id = j.requested_by_user_id AND m.status = 'ativo' AND m.role = 'admin'))`)
    const privateRow = rows[0]
    if (!privateRow) throw new ExecutorError(403, 'ADMIN_REQUIRED')
    const markers = new Map(Object.entries(typeof privateRow.marcadores === 'string' ? JSON.parse(privateRow.marcadores) as Record<string, string> : privateRow.marcadores))
    // A leitura legada tolera marcador ausente. O contrato externo exige
    // recusa também nas ações de leitura e no texto de resposta.
    validarMarcadores(parsed.data, markers)
    const settings = await databaseRepository.settings(l.companyId)
    if (!settings) throw new ExecutorError(403, 'DISABLED')
    const result = await aplicarPlanoDoModelo({ input: { companyId: l.companyId, userId: privateRow.requested_by_user_id, role: privateRow.role, actorName: privateRow.ator_nome }, id: l.jobId, settings,
      redacted: { text: '', markers }, text: privateRow.texto_original },
    { plan: parsed.data, model: body.modelo, usage: { inputTokens, outputTokens: body.uso.saida } })
    code = result.job.errorCode ?? (parsed.data.actions.every(a => a.type === 'recusar') ? 'RECUSADO' : null)
  } catch (error) {
    code = error instanceof ExecutorError ? error.code : error instanceof OperatorServiceError ? error.code : 'INVALID_PLAN'
    await databaseRepository.settle!(l.companyId, l.jobId, { status: 'falhou', errorCode: code, resultText: code === 'INVALID_MESSAGE' ? 'Qual é a mensagem que devo enviar? Escreva assim: mensagem: ...' : 'O plano foi recusado. Nenhuma nova ação será aplicada.', tokensIn: inputTokens, tokensOut: body.uso.saida, model: body.modelo, finishedAt: new Date() }, inputTokens + body.uso.saida)
  }
  const result = await db.execute(sql`WITH delivered AS (
    UPDATE sac_operator_queue q SET estado = 'entregue', erro_codigo = ${code}, modelo = ${body.modelo}, tokens_entrada = ${body.uso.entrada}, tokens_cache = ${body.uso.cache}, tokens_saida = ${body.uso.saida}, duracao_ms = ${body.duracaoMs}, concluido_em = now(), updated_at = now()
    WHERE ${liveLease(l)} AND q.estado = 'aplicando' RETURNING q.job_id, q.company_id
  ), deleted AS (
    DELETE FROM sac_operator_job_privados p USING delivered d WHERE p.company_id = ${l.companyId} AND p.company_id = d.company_id AND p.job_id = d.job_id RETURNING p.job_id
  ) SELECT job_id FROM delivered`)
  if (!result.rows.length) throw new ExecutorError(409, 'LEASE_CONFLICT')
  return savedResponse(code)
}
function savedResponse(code: string | null): CompleteResponse { return { estado: code ? 'recusado' : 'aplicado', codigo: code ?? 'OK' } }

function validarMarcadores(value: unknown, markers: Map<string, string>): void {
  if (typeof value === 'string') resolverMarcadores(value, markers)
  else if (value && typeof value === 'object') for (const item of Object.values(value)) validarMarcadores(item, markers)
}
