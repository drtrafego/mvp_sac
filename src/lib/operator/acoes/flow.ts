import { mensagemErro } from './error-messages'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sacOperatorActions, sacOperatorJobs, sacOperatorCompanySettings } from '../schema'
import { OperatorServiceError, type OperatorJob, type OperatorSettings } from '../service'
import { executeReadAction } from '../actions/read'
import { acoesPlanSchema, RECUSA_TEXTO, type AcoesPlan } from './catalog'
import { completarAcao, disponivelNestaFatia, prepararPlano } from './prepare'
import { acoesDoJob, executarJob } from './execute'
import { resolverMarcadores } from './markers'
import { planHash } from './canonical'
import { postgresCode } from './sql'
import { PRAZO_ESPERA_MIN, MAX_APELIDOS } from './limits'
import { colunasDaEmpresa, norm } from './resolve-stage'
import { publicAction, publicJob } from './public-view'
import type { Ator, FlowOutcome, PreparedAction } from './types'

export async function getJob(companyId: number, id: string): Promise<OperatorJob> {
  const [job] = await db.select().from(sacOperatorJobs).where(and(eq(sacOperatorJobs.companyId, companyId), eq(sacOperatorJobs.id, id))).limit(1)
  if (!job) throw new OperatorServiceError('Job não encontrado.', 404, 'JOB_NOT_FOUND')
  return job
}
export async function expireWaitingJobs(companyId: number) {
  // expireStuck encerra o job; os recibos atômicos dizem o que já ocorreu.
  // Reconcilia recibos uma vez; só regrava se um recibo tardio mudar o resultado.
  await db.execute(sql`WITH stopped AS (
    UPDATE sac_operator_actions SET status = 'falhou', after_snapshot = '{"erro":"JOB_TIMEOUT"}'::jsonb
    WHERE company_id = ${companyId} AND status IN ('pendente', 'aguardando_confirmacao')
      AND job_id IN (SELECT id FROM sac_operator_jobs WHERE company_id = ${companyId} AND error_code = 'JOB_TIMEOUT') RETURNING id
  ), receipts AS (
    SELECT a.job_id, jsonb_build_object('acoes', true,
      'aplicadas', coalesce(jsonb_agg(a.id ORDER BY a.ordinal) FILTER (WHERE a.status = 'concluido'), '[]'::jsonb),
      'naoAplicadas', coalesce(jsonb_agg(a.id ORDER BY a.ordinal) FILTER (WHERE a.status <> 'concluido'), '[]'::jsonb)) AS result,
      string_agg(CASE WHEN a.status = 'concluido' THEN 'Executado: ' ELSE 'Não aplicado: ' END || (a.request_json->>'resumo'), E'\n' ORDER BY a.ordinal) AS summary
    FROM sac_operator_actions a JOIN sac_operator_jobs j ON j.id = a.job_id AND j.company_id = a.company_id
    WHERE a.company_id = ${companyId} AND j.error_code = 'JOB_TIMEOUT' GROUP BY a.job_id
  ) UPDATE sac_operator_jobs j SET result_json = receipts.result,
    result_text = 'O pedido expirou. Confira as ações registradas.' || E'\n' || receipts.summary
    FROM receipts WHERE j.id = receipts.job_id AND j.company_id = ${companyId}
      AND (j.result_json IS DISTINCT FROM receipts.result OR
        j.result_text IS DISTINCT FROM ('O pedido expirou. Confira as ações registradas.' || E'\n' || receipts.summary))`)
  await db.execute(sql`WITH exp AS (UPDATE sac_operator_jobs SET status = 'falhou',
    error_code = CASE waiting_reason WHEN 'confirmacao' THEN 'CONFIRMATION_EXPIRED' ELSE 'CLARIFICATION_EXPIRED' END,
    result_text = 'O prazo de 15 minutos venceu. Nada foi alterado.', finished_at = now(), updated_at = now()
    WHERE company_id = ${companyId} AND status = 'aguardando_confirmacao' AND confirmation_expires_at <= now() RETURNING id)
    UPDATE sac_operator_actions SET status = 'cancelado' WHERE company_id = ${companyId} AND job_id IN (SELECT id FROM exp) AND status IN ('pendente', 'aguardando_confirmacao')`)
}
export function outcome(actions: PreparedAction[], extra: { results?: unknown[]; recusas?: string[] } = {}): FlowOutcome {
  const waiting = actions.some(a => a.requestJson.esclarecimento && a.status === 'pendente')
  const failed = actions.find(a => a.status === 'falhou' || a.status === 'cancelado')
  const text = waiting ? 'Escolha uma das opções para continuar. Nada foi alterado.' : [
    ...actions.map(a => a.status === 'concluido'
      ? a.requestJson.semEfeito ? a.requestJson.resumo : `${a.actionType.startsWith('desfazer_') ? 'Desfeito' : 'Executado'}: ${a.requestJson.resumo}`
      : `Não aplicado: ${a.requestJson.resumo} (${mensagemErro(a.afterSnapshot?.erro ?? a.status)}).`), ...(extra.recusas ?? []),
  ].join('\n') || 'Consulta concluída.'
  return { status: waiting ? 'aguardando_confirmacao' : failed ? 'falhou' : 'concluido', waitingReason: waiting ? 'esclarecimento' : null,
    confirmationExpiresAt: waiting ? new Date(Date.now() + PRAZO_ESPERA_MIN * 60000) : null, planHash: planHash(actions),
    resultText: text, errorCode: failed?.afterSnapshot?.erro ?? null,
    resultJson: { ...extra, acoes: true, aplicadas: actions.filter(a => a.status === 'concluido').map(a => a.id), naoAplicadas: actions.filter(a => a.status !== 'concluido').map(a => a.id) } }
}
export async function handleWritePlan(input: { ator: Ator; jobId: string; plan: AcoesPlan; markers: Map<string, string>; textoOriginal: string; settings: OperatorSettings }): Promise<FlowOutcome> {
  const { ator, jobId, markers, textoOriginal, settings } = input
  const plan = acoesPlanSchema.parse(input.plan)
  const actions = plan.actions.map(a => disponivelNestaFatia(a.type) ? a : { type: 'recusar' as const, motivo: 'fora_do_catalogo' as const })
  if (actions.some(a => a.type !== 'recusar' && !settings.allowedActions.includes(a.type)))
    throw new OperatorServiceError('Esta ação não está liberada para esta empresa.', 403, 'ACTION_NOT_ALLOWED')
  const results = []; const recusas: string[] = []
  for (const a of actions) {
    if (a.type === 'recusar') recusas.push(RECUSA_TEXTO[a.motivo])
    else if (a.type === 'buscar_lead' || a.type === 'listar_etapas' || a.type === 'listar_regras_instagram')
      results.push(await executeReadAction(ator.companyId, a.type === 'buscar_lead' ? { ...a, query: resolverMarcadores(a.query, markers) } : a))
  }
  const prepared = await prepararPlano(ator, jobId, { ...plan, actions }, markers, textoOriginal, settings)
  for (const a of prepared) await db.insert(sacOperatorActions).values(a).onConflictDoNothing({ target: [sacOperatorActions.companyId, sacOperatorActions.idempotencyKey] })
  if (prepared.some(a => a.requestJson.esclarecimento)) return outcome(prepared, { results, recusas })
  return outcome(await executarJob(ator, jobId), { results, recusas })
}
export async function jobView(ator: Ator, id: string) {
  await expireWaitingJobs(ator.companyId)
  const job = await getJob(ator.companyId, id)
  const actions = await acoesDoJob(ator.companyId, id)
  const undoJobs = await db.execute<{ original: string; status: string; error: string | null }>(sql`SELECT substring(idempotency_key FROM 6) AS original, status, error_code AS error
    FROM sac_operator_jobs WHERE company_id = ${ator.companyId}
      AND idempotency_key IN (SELECT 'undo:' || id::text FROM sac_operator_actions WHERE job_id = ${id}::uuid AND company_id = ${ator.companyId})`)
  return { job: publicJob(job), acoes: actions.map(a => {
    const undo = undoJobs.rows.find(u => u.original === a.id)
    return publicAction(a, job, undo?.status === 'concluido', undo?.error ?? undefined, !!undo)
  }) }
}
export async function finalizarJob(ator: Ator, id: string, value: FlowOutcome) {
  await db.update(sacOperatorJobs).set({ ...value, updatedAt: new Date(), finishedAt: value.status === 'aguardando_confirmacao' ? null : new Date() })
    .where(and(eq(sacOperatorJobs.companyId, ator.companyId), eq(sacOperatorJobs.id, id), eq(sacOperatorJobs.status, 'em_execucao')))
}
export type Choice = { actionId: string; leadId?: number; etapaId?: string; ruleId?: number; lembrarApelido?: boolean }
export async function clarifyJob(ator: Ator, jobId: string, choice: Choice) {
  await expireWaitingJobs(ator.companyId)
  const job = await getJob(ator.companyId, jobId)
  if (job.errorCode === 'CLARIFICATION_EXPIRED') throw new OperatorServiceError('O prazo para escolher venceu.', 410, job.errorCode)
  if (job.status !== 'aguardando_confirmacao' || job.waitingReason !== 'esclarecimento') throw new OperatorServiceError('Este pedido não espera uma escolha.', 409, 'INVALID_STATE')
  const actions = await acoesDoJob(ator.companyId, jobId)
  const a = actions.find(a => a.id === choice.actionId)
  const clarify = a?.requestJson.esclarecimento
  if (!a || !clarify || (clarify.tipo === 'lead' ? !clarify.candidatos.some(c => c.leadId === choice.leadId) : !clarify.opcoes.some(c => c.id === choice.etapaId)))
    throw new OperatorServiceError('Escolha uma opção oferecida.', 400, 'INVALID_CHOICE')
  if (choice.lembrarApelido && clarify.tipo !== 'etapa') throw new OperatorServiceError('Só etapas podem ter apelidos.', 400, 'INVALID_CHOICE')
  if (clarify.tipo === 'etapa' && !(await colunasDaEmpresa(ator.companyId)).some(c => c.id === choice.etapaId)) throw new OperatorServiceError('A etapa mudou.', 409, 'CONFLICT')
  const alias = choice.lembrarApelido && clarify.tipo === 'etapa' ? norm(clarify.termo) : undefined
  if (alias !== undefined && (!alias || alias.length > 40)) throw new OperatorServiceError('Apelido deve ter até 40 caracteres.', 400, 'INVALID_ALIAS')
  const request = { ...a.requestJson, ...(clarify.tipo === 'lead' ? { leadId: choice.leadId } : { etapaId: choice.etapaId }) }
  delete request.esclarecimento
  // A escolha e a posse do job são reivindicadas juntas: uma resposta 409
  // nunca deixa uma escolha que outra requisição possa executar.
  try {
    const claimed = await db.execute<{ claims: number }>(sql`WITH owner AS (
      UPDATE sac_operator_jobs SET status = 'em_execucao', waiting_reason = NULL, updated_at = now()
      WHERE id = ${jobId}::uuid AND company_id = ${ator.companyId} AND status = 'aguardando_confirmacao'
        AND waiting_reason = 'esclarecimento' AND confirmation_expires_at > now() RETURNING id
    ), chosen AS (
      UPDATE sac_operator_actions SET request_json = ${JSON.stringify(request)}::jsonb
      WHERE id = ${a.id}::uuid AND company_id = ${ator.companyId} AND job_id IN (SELECT id FROM owner)
        AND status = 'pendente' AND request_json = ${JSON.stringify(a.requestJson)}::jsonb AND request_json ? 'esclarecimento' RETURNING id
    ), chk AS (SELECT 1 / CASE WHEN (SELECT count(*) FROM owner) = (SELECT count(*) FROM chosen) THEN 1 ELSE 0 END AS ok)
    SELECT (SELECT count(*) FROM chosen)::int AS claims, ok FROM chk`)
    if (!claimed.rows[0]?.claims) throw new OperatorServiceError('O pedido está sendo tratado.', 409, 'CONFLICT')
  } catch (error) {
    if (postgresCode(error) === '22012') throw new OperatorServiceError('A escolha já foi tratada ou o pedido mudou.', 409, 'CONFLICT')
    throw error
  }
  try {
    const [config] = await db.select({ aliases: sacOperatorCompanySettings.stageAliases }).from(sacOperatorCompanySettings).where(eq(sacOperatorCompanySettings.companyId, ator.companyId)).limit(1)
    const prepared: PreparedAction[] = []
    for (const current of await acoesDoJob(ator.companyId, jobId)) {
      const next = await completarAcao(ator, current, config?.aliases ?? {})
      await db.update(sacOperatorActions).set({ requestJson: next.requestJson, targetId: next.targetId, beforeSnapshot: next.beforeSnapshot })
        .where(and(eq(sacOperatorActions.id, next.id), eq(sacOperatorActions.companyId, ator.companyId), eq(sacOperatorActions.status, 'pendente')))
      prepared.push(next)
    }
    if (alias !== undefined) {
      await db.execute(sql`WITH saved AS (UPDATE sac_operator_company_settings SET stage_aliases = stage_aliases || jsonb_build_object(${alias}::text, ${choice.etapaId}::text), updated_at = now()
        WHERE company_id = ${ator.companyId} AND enabled AND NOT kill_switch AND allowed_actions ? 'mover_etapa'
          AND jsonb_typeof(stage_aliases) = 'object' AND (SELECT count(*) FROM jsonb_object_keys(stage_aliases)) < ${MAX_APELIDOS} RETURNING company_id)
        INSERT INTO sac_audit_events (company_id, type, actor_type, actor_id, actor_name, reference_type, reference_id, payload)
        SELECT company_id, 'operator_stage_alias_saved', 'human', ${ator.userId}, ${ator.actorName}, 'sac_operator_jobs', ${jobId},
          jsonb_build_object('origem', 'operador_sac', 'apelido', ${alias}::text, 'etapa', ${choice.etapaId}::text) FROM saved`)
    }
    const extra = job.resultJson as { results?: unknown[]; recusas?: string[] } | null
    await finalizarJob(ator, jobId, outcome(prepared.some(a => a.requestJson.esclarecimento) ? prepared : await executarJob(ator, jobId), extra ?? {}))
  } catch (error) {
    await db.execute(sql`UPDATE sac_operator_actions SET status = 'falhou', after_snapshot = '{"erro":"CLARIFICATION_FAILED"}'::jsonb WHERE company_id = ${ator.companyId} AND job_id = ${jobId}::uuid AND status = 'pendente'`)
    await finalizarJob(ator, jobId, outcome(await acoesDoJob(ator.companyId, jobId)))
    throw error
  }
  return jobView(ator, jobId)
}
export async function cancelJob(ator: Ator, id: string) {
  await getJob(ator.companyId, id)
  const result = await db.execute(sql`WITH cancelled AS (UPDATE sac_operator_jobs SET status = 'cancelado', waiting_reason = NULL,
    result_text = ${'Cancelado por ' + ator.actorName + '.'}, updated_at = now(), finished_at = now()
    WHERE id = ${id}::uuid AND company_id = ${ator.companyId} AND status = 'aguardando_confirmacao' RETURNING id), actions AS (
    UPDATE sac_operator_actions SET status = 'cancelado' WHERE job_id IN (SELECT id FROM cancelled) AND company_id = ${ator.companyId} AND status IN ('pendente', 'aguardando_confirmacao') RETURNING id)
    SELECT id FROM cancelled`)
  if (!result.rows.length) throw new OperatorServiceError('O pedido não pode mais ser cancelado.', 409, 'INVALID_STATE')
  return jobView(ator, id)
}
export async function confirmJob(ator: Ator, id: string) {
  await getJob(ator.companyId, id)
  throw new OperatorServiceError('Confirmação de regras indisponível nesta fase.', 409, 'NOT_AVAILABLE')
}
