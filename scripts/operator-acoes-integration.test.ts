// Corpos HTTP de teste são validados por assertions de status e conteúdo.
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createOperatorAcoesHarness, operatorRequest, type QaHarness } from './operator-acoes-harness'
let h: QaHarness
before(async () => { h = await createOperatorAcoesHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => {
  h.fresh()
  await h.sql`UPDATE sac_operator_company_settings SET enabled=true, kill_switch=false, allowed_actions='["buscar_lead","listar_etapas","listar_regras_instagram","mover_etapa","anotar_lead"]', stage_aliases='{}', max_jobs_per_day=1000, daily_usage_date=NULL, daily_jobs_reserved=0, daily_tokens_reserved=0`
  await h.sql`UPDATE recovery_leads SET pipeline_stage=NULL, context_version=1 WHERE id IN (${h.leadA},${h.twin1},${h.twin2})`
})
const move = (etapa = 'agendado', lead = '[T1] [T2]') => ({ type: 'mover_etapa', lead, etapa })
const note = (texto = 'pediu retorno amanhã', lead = '[T1] [T2]') => ({ type: 'anotar_lead', lead, texto })
function plan(actions: unknown[]) { h.state.plan = { actions, response: 'ok' } }
async function actions(id: string) { return h.execute.acoesDoJob(h.state.company.id, id) }

test('T-CORPO-1/T-MOVE-1/T-NOTA-1: rotas reais, snapshot estrito, recibos e auditoria', async () => {
  const before = (await h.sql`SELECT to_jsonb(l) v FROM recovery_leads l WHERE id=${h.leadA}`)[0].v
  const protectedBefore = await h.protectedState()
  plan([move(), note()])
  const r = await h.post('Mova Mariana Souza para agendado e anote que pediu retorno amanhã')
  assert.equal(r.status, 202); assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  const rows = await actions(r.body.job.id); assert.equal(rows.length, 2); assert.ok(rows.every(a => a.status === 'concluido'))
  assert.equal(rows[0].beforeSnapshot?.pipelineStage, null); assert.equal(rows[0].afterSnapshot?.contextVersion, 2)
  const after = (await h.sql`SELECT to_jsonb(l) v FROM recovery_leads l WHERE id=${h.leadA}`)[0].v
  assert.deepEqual(Object.keys(before).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort(), ['pipeline_stage', 'context_version', 'updated_at', 'last_action_by', 'last_action_at'].sort())
  assert.equal(after.last_action_by, 'Admin de teste (Operador SAC)')
  const n = (await h.sql`SELECT * FROM sac_internal_notes WHERE id=${rows[1].afterSnapshot!.noteId!}`)[0]
  assert.deepEqual([n.body, n.author_type, n.author_id], ['pediu retorno amanhã', 'human', h.state.user])
  const audit = await h.sql`SELECT type FROM sac_audit_events WHERE payload->>'jobId'=${r.body.job.id} ORDER BY id`
  assert.deepEqual(audit.map(a => a.type), ['context_updated', 'internal_note_added'])
  assert.equal(await h.protectedState(), protectedBefore)
  const body = h.modelBodies.at(-1); assert.equal(body.messages.length, 2); assert.doesNotMatch(JSON.stringify(body), /Mariana|Souza|98888|7777/)
  assert.equal((await h.call('acoes', r.body.job.id)).body.acoes[0].podeDesfazer, true)
  assert.doesNotMatch(JSON.stringify((await h.call('acoes', r.body.job.id)).body), /contextVersion|beforeSnapshot|referencia/)
})
test('T-CORPO-1/2/T-MOVE-3: chamada pede escolha, lembra apelido, não chama modelo novamente', async () => {
  plan([move('chamada')]); const count = h.modelBodies.length
  const r = await h.post('Mova a Mariana Souza, telefone 11 98888-7777, para chamada e anote que ela pediu retorno amanhã')
  assert.equal(r.body.job.status, 'aguardando_confirmacao')
  assert.match(h.modelBodies.at(-1).messages[1].content, /\[CONTATO_1\]/)
  const [a] = await actions(r.body.job.id)
  assert.equal(a.requestJson.esclarecimento?.tipo, 'etapa')
  const chosen = await h.call('clarify', r.body.job.id, { actionId: a.id, etapaId: 'agendado', lembrarApelido: true })
  assert.equal(chosen.status, 200); assert.equal(chosen.body.job.status, 'concluido', JSON.stringify(chosen.body))
  assert.equal(h.modelBodies.length, count + 1)
  assert.equal((await h.sql`SELECT stage_aliases FROM sac_operator_company_settings WHERE company_id=${h.A.id}`)[0].stage_aliases.chamada, 'agendado')
  const again = await h.post('Mova Mariana Souza para chamada'); assert.equal(again.body.job.status, 'concluido')
})
test('T-MOVE-2: homônimo, ids não oferecidos e outra empresa rejeitados antes de agir', async () => {
  plan([move()]); const r = await h.post('Mova João Silva para agendado'); assert.equal(r.body.job.waitingReason, 'esclarecimento')
  const [a] = await actions(r.body.job.id); assert.equal(a.requestJson.esclarecimento?.tipo, 'lead')
  for (const id of [h.leadA, h.leadB]) assert.equal((await h.call('clarify', r.body.job.id, { actionId: a.id, leadId: id })).status, 400)
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${h.twin1}`)[0].pipeline_stage, null)
  assert.equal((await h.call('clarify', r.body.job.id, { actionId: a.id, leadId: h.twin1 })).body.job.status, 'concluido')
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${h.twin2}`)[0].pipeline_stage, null)
})
test('R2: #id é explícito, final de telefone não usa o id numérico e nomes curtos pedem segurança', async () => {
  await h.sql`INSERT INTO recovery_leads (id, company_id, platform, event_type, phone, name, status, bot_paused, bot_paused_all, bot_paused_by)
    VALUES (4321, ${h.A.id}, 'sac', 'manual', '551199990000', 'Fulano Do Id', 'pending', true, true, 'QA')`
  const phoneLead = await h.lead(h.A.id, 'Ciclano Do Fone', null, '551199994321')
  plan([move('agendado', '[T2]')])
  const byPhone = await h.post('Mova o lead com final de telefone 4321 para agendado')
  assert.equal(byPhone.body.job.status, 'concluido', JSON.stringify(byPhone.body))
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=4321`)[0].pipeline_stage, null)
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${phoneLead}`)[0].pipeline_stage, 'agendado')

  await h.sql`UPDATE recovery_leads SET pipeline_stage=NULL WHERE id=${phoneLead}`
  plan([move('agendado', '[T1]')])
  const ana = await h.post('Mova Ana para agendado')
  assert.equal(ana.status, 404)
  assert.equal(ana.body.code, 'LEAD_NOT_FOUND')
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${h.leadA}`)[0].pipeline_stage, null)

  const exactAna = await h.lead(h.A.id, 'Ana Lima', null, '551199995555')
  const entire = await h.post('Mova Ana para agendado')
  assert.equal(entire.body.job.status, 'concluido')
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${exactAna}`)[0].pipeline_stage, 'agendado')
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${h.leadA}`)[0].pipeline_stage, null)
  const explicit = await h.post('Mova #4321 para agendado')
  assert.equal(explicit.body.job.status, 'concluido')
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=4321`)[0].pipeline_stage, 'agendado')
  assert.equal((await h.post('Mova 123 para agendado')).body.code, 'LEAD_AMBIGUOUS')

  const fernanda = await h.lead(h.A.id, 'Fernanda Borges', null, '551188877766')
  plan([move('agendado', '[T1]')])
  const fern = await h.post('Mova Fern para agendado')
  assert.equal(fern.body.job.status, 'aguardando_confirmacao', JSON.stringify(fern.body))
  const [pending] = await actions(fern.body.job.id)
  assert.equal(pending.requestJson.esclarecimento?.tipo, 'lead')
  assert.deepEqual(pending.requestJson.esclarecimento?.candidatos.map((c: { leadId: number }) => c.leadId), [fernanda])
})
test('R2: 50 leituras do histórico não impedem um novo seletor de esclarecimento', async () => {
  const fernanda = await h.lead(h.A.id, 'Fernanda Borges', null, '551188877765')
  plan([move('agendado', '[T1]')])
  const pending = await h.post('Mova Fern para agendado')
  assert.equal(pending.body.job.status, 'aguardando_confirmacao')
  const statuses = await Promise.all(Array.from({ length: 50 }, () => h.call('acoes', pending.body.job.id).then(r => r.status)))
  assert.ok(statuses.every(status => status === 200), String(statuses))
  plan([move('agendado', '[T1]')])
  const next = await h.post('Mova Fern para agendado')
  assert.equal(next.body.job.status, 'aguardando_confirmacao', JSON.stringify(next.body))
  const view = await h.call('acoes', next.body.job.id)
  assert.equal(view.status, 200)
  assert.equal(view.body.acoes[0].esclarecimento.tipo, 'lead')
  assert.ok(fernanda)
})
test('T-MOVE-4/5: noop preserva NULL; marcador obrigatório e desconhecido falham', async () => {
  plan([move('novo_contato')]); const before = await h.sql`SELECT to_jsonb(l) v FROM recovery_leads l WHERE id=${h.leadA}`
  const r = await h.post(); assert.equal(r.body.job.status, 'concluido')
  assert.deepEqual(await h.sql`SELECT to_jsonb(l) v FROM recovery_leads l WHERE id=${h.leadA}`, before)
  assert.equal((await h.call('acoes', r.body.job.id)).body.acoes[0].podeDesfazer, false)
  plan([move('agendado', 'Fernanda')]); assert.equal((await h.post()).body.code, 'MARKER_REQUIRED')
  plan([move('agendado', '[T99]')]); assert.equal((await h.post()).body.code, 'MARKER_UNKNOWN')
  plan([move('agendado', '[T1]')]); assert.equal((await h.post(`Mova #${h.leadB} para agendado`)).status, 404)
})
test('T-NOTA-1/T-DESF-3: texto reescrito identificado e exclusão lógica só da nota exata', async () => {
  plan([note('frase reescrita')]); const r = await h.post('Anote Mariana Souza pediu retorno amanhã')
  assert.equal(r.body.job.status, 'concluido'); const [a] = await actions(r.body.job.id)
  const [other] = await h.sql`INSERT INTO sac_internal_notes (company_id, lead_id, author_type, body) VALUES (${h.A.id}, ${h.twin1}, 'human', 'preservar') RETURNING id`
  assert.equal((await h.sql`SELECT body FROM sac_internal_notes WHERE id=${a.afterSnapshot!.noteId!}`)[0].body, 'Operador SAC: frase reescrita')
  const undone = await h.call('undo', a.id); assert.equal(undone.status, 202); assert.equal(undone.body.job.status, 'concluido')
  assert.ok((await h.sql`SELECT deleted_at FROM sac_internal_notes WHERE id=${a.afterSnapshot!.noteId!}`)[0].deleted_at)
  assert.equal((await h.sql`SELECT deleted_at FROM sac_internal_notes WHERE id=${other.id}`)[0].deleted_at, null)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE type='internal_note_deleted' AND reference_id=${String(a.afterSnapshot!.noteId)}`)[0].n, 1)
})
test('T-DESF-1/2: desfazer restaura NULL uma vez, conflitos com painel e sync preservados', async () => {
  plan([move()]); const r = await h.post(); const [a] = await actions(r.body.job.id)
  const undo = await h.call('undo', a.id); const twice = await h.call('undo', a.id)
  assert.equal(undo.body.job.status, 'concluido'); assert.equal(twice.status, 200); assert.equal(twice.body.reused, true); assert.equal(twice.body.job.id, undo.body.job.id)
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${h.leadA}`)[0].pipeline_stage, null)
  assert.equal((await h.call('acoes', r.body.job.id)).body.acoes[0].desfeita, true)
  for (const bump of [true, false]) {
    const r2 = await h.post(); const [a2] = await actions(r2.body.job.id)
    if (bump) await h.sql`UPDATE recovery_leads SET pipeline_stage='qualificado', context_version=context_version+1 WHERE id=${h.leadA}`
    else await h.sql`UPDATE recovery_leads SET pipeline_stage='qualificado' WHERE id=${h.leadA}`
    const failed = await h.call('undo', a2.id); assert.equal(failed.body.job.errorCode, 'CONFLICT')
    const failedView = (await h.call('acoes', r2.body.job.id)).body.acoes[0]
    assert.equal(failedView.podeDesfazer, false)
    assert.match(failedView.erroDesfazer ?? '', /CONFLICT|Mudou depois|não desfeito/i)
    assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${h.leadA}`)[0].pipeline_stage, 'qualificado')
  }
})
test('R2: apelido longo é recusado antes de reivindicar a escolha', async () => {
  const longAlias = 'x'.repeat(41)
  plan([move(longAlias)])
  const r = await h.post(`Mova Mariana Souza para ${longAlias}`)
  assert.equal(r.body.job.status, 'aguardando_confirmacao', JSON.stringify(r.body))
  const [a] = await actions(r.body.job.id)
  const clarification = a.requestJson.esclarecimento
  assert.equal(clarification?.tipo, 'etapa')
  if (!clarification || clarification.tipo !== 'etapa') throw new Error('esperava esclarecimento de etapa')
  const options = clarification.opcoes
  assert.ok(options?.length)
  const chosen = await h.call('clarify', r.body.job.id, { actionId: a.id, etapaId: options[0].id, lembrarApelido: true })
  assert.equal(chosen.status, 400)
  assert.equal(chosen.body.code, 'INVALID_ALIAS')
  assert.equal((await actions(r.body.job.id))[0].status, 'pendente')
  assert.equal((await h.sql`SELECT status FROM sac_operator_jobs WHERE id=${r.body.job.id}`)[0].status, 'aguardando_confirmacao')
})
test('T-IDOR-1/2/4: todas as rotas isolam tenant, inclusive platform_admin trocando de empresa', async () => {
  plan([move('chamada')]); const r = await h.post(); const [a] = await actions(r.body.job.id)
  h.state.company = h.B; h.state.role = 'platform_admin'
  const before = await h.protectedState()
  for (const route of ['get', 'acoes', 'cancel', 'undo', 'clarify'] as const) {
    const body = route === 'clarify' ? { actionId: a.id, etapaId: 'agendado' } : {}
    assert.equal((await h.call(route, route === 'undo' ? a.id : r.body.job.id, body)).status, 404, route)
  }
  await assert.rejects(() => h.flow.confirmJob(h.actor(), r.body.job.id, { planHash: '0'.repeat(64), codigo: 'teste' }), { status: 404 })
  assert.equal(await h.protectedState(), before)
})
test('T-ADMIN-1/T-DESL-1/T-KILL-1: 401/403 em todas as rotas e painel em quatro estados', async () => {
  const page = await import('../src/app/(dashboard)/operar/page')
  const description = async () => { const e = await page.default() as any; const c = e.props.children; return (Array.isArray(c) ? c[0] : c).props.description as string }
  plan([move('chamada')]); const r = await h.post(); const [a] = await actions(r.body.job.id)
  for (const [mode, code] of [['member', 403], ['none', 401], ['agent', 401], ['redirect', 401]] as const) {
    h.state.mode = mode
    assert.equal((await h.post()).status, code)
    for (const route of ['get', 'acoes', 'cancel', 'undo', 'clarify'] as const) assert.equal((await h.call(route, route === 'undo' ? a.id : r.body.job.id, route === 'clarify' ? { actionId: a.id, etapaId: 'agendado' } : {})).status, code)
    if (mode !== 'redirect') assert.match(await description(), /Sem permissão/)
  }
  h.fresh()
  for (const which of ['enabled', 'kill_switch']) {
    if (which === 'enabled') await h.sql`UPDATE sac_operator_company_settings SET enabled=false WHERE company_id=${h.A.id}`
    else await h.sql`UPDATE sac_operator_company_settings SET enabled=true, kill_switch=true WHERE company_id=${h.A.id}`
    const count = h.modelBodies.length; assert.equal((await h.post()).status, 403); assert.equal(h.modelBodies.length, count)
    for (const route of ['get', 'acoes', 'cancel', 'undo', 'clarify'] as const) assert.equal((await h.call(route, route === 'undo' ? a.id : r.body.job.id, {})).status, 403)
    assert.match(await description(), /Operador desligado/)
  }
  await h.sql`UPDATE sac_operator_company_settings SET enabled=true,kill_switch=false WHERE company_id=${h.A.id}`
  assert.match(await description(), /Operações da empresa/)
})
test('T-IDOR-3/T-CSRF-1: campos extras, Origin ausente/externo e conteúdo incorreto rejeitados', async () => {
  plan([move('chamada')]); const r = await h.post(); const [a] = await actions(r.body.job.id)
  for (const key of ['companyId', 'userId', 'role', 'status']) {
    h.fresh(); assert.equal((await h.post(undefined, undefined, { [key]: 999 })).status, 400)
    for (const route of ['clarify', 'cancel', 'undo'] as const) assert.equal((await h.call(route, route === 'undo' ? a.id : r.body.job.id, { ...(route === 'clarify' ? { actionId: a.id, etapaId: 'agendado' } : {}), [key]: 999 })).status, 400)
  }
  for (const headers of [{ origin: '' }, { origin: 'https://evil.test' }, { 'content-type': 'text/plain' }]) {
    h.fresh(); assert.equal((await h.post(undefined, undefined, {}, headers)).status, 403)
    for (const route of ['clarify', 'cancel', 'undo'] as const) assert.equal((await h.call(route, route === 'undo' ? a.id : r.body.job.id, {}, headers)).status, 403)
  }
  const before = await h.protectedState(); plan([{ ...move(), companyId: h.B.id }]); assert.equal((await h.post()).body.job.status, 'falhou'); assert.equal(await h.protectedState(), before)
})
test('R2: proxy público aceito; Origin obrigatório antes da cota; POST continua limitado', async () => {
  plan([move()])
  for (const headers of [{ origin: 'https://preview.test', 'x-forwarded-host': 'preview.test', 'x-forwarded-proto': 'https' }, { origin: 'https://preview.test', host: 'preview.test' }]) {
    h.fresh()
    assert.equal((await h.post(undefined, undefined, {}, headers)).status, 202)
  }
  h.fresh()
  const calls = h.modelBodies.length
  for (let i = 0; i < 21; i++) assert.equal((await h.post(undefined, undefined, {}, { origin: '' })).status, 403)
  assert.equal(h.modelBodies.length, calls)
  assert.equal((await h.post()).status, 202)
  const missing = randomUUID()
  for (let i = 0; i < 20; i++) assert.equal((await h.call('cancel', missing)).status, 404)
  assert.equal((await h.call('cancel', missing)).status, 429)
})
test('R2: nota com tabulação e CRLF preserva conteúdo normalizado', async () => {
  plan([note('pediu\tretorno\r\namanhã')])
  const r = await h.post('Anote Mariana Souza pediu retorno amanhã')
  assert.equal(r.body.job.status, 'concluido')
  const [a] = await actions(r.body.job.id)
  assert.equal((await h.sql`SELECT body FROM sac_internal_notes WHERE id=${a.afterSnapshot!.noteId!}`)[0].body, 'pediu retorno\namanhã')
})
test('T-PERM-1/T-DESL-1/T-KILL-1: gate SQL revalida permissão/disponibilidade depois do preparo', async () => {
  await h.sql`UPDATE sac_operator_company_settings SET allowed_actions='["anotar_lead"]' WHERE company_id=${h.A.id}`
  plan([move()]); const denied = await h.post(); assert.equal(denied.body.code, 'ACTION_NOT_ALLOWED')
  for (const mode of ['disabled', 'kill', 'permission']) {
    await h.sql`UPDATE sac_operator_company_settings SET enabled=true,kill_switch=false,allowed_actions='["mover_etapa","anotar_lead"]' WHERE company_id=${h.A.id}`
    const p = await h.prepared([move(), note()], 'Mova Mariana Souza e anote pediu retorno amanhã')
    if (mode === 'disabled') await h.sql`UPDATE sac_operator_company_settings SET enabled=false WHERE company_id=${h.A.id}`
    if (mode === 'kill') await h.sql`UPDATE sac_operator_company_settings SET kill_switch=true WHERE company_id=${h.A.id}`
    if (mode === 'permission') await h.sql`UPDATE sac_operator_company_settings SET allowed_actions='[]' WHERE company_id=${h.A.id}`
    for (const a of p.actions) assert.equal((await h.execute.executarAcao(h.actor(), p.jobId, a)).afterSnapshot?.erro, 'GATE_CLOSED')
    assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${h.leadA}`)[0].pipeline_stage, null)
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE payload->>'jobId'=${p.jobId}`)[0].n, 0)
  }
})
test('T-COTA-1: quota bloqueia modelo, mas permite esclarecimento e Desfazer', async () => {
  plan([move('chamada')]); const r = await h.post(); const [a] = await actions(r.body.job.id)
  await h.sql`UPDATE sac_operator_company_settings SET max_jobs_per_day=0 WHERE company_id=${h.A.id}`
  const calls = h.modelBodies.length; assert.equal((await h.post()).status, 429); assert.equal(h.modelBodies.length, calls)
  const quota = (await h.sql`SELECT daily_jobs_reserved,daily_tokens_reserved FROM sac_operator_company_settings WHERE company_id=${h.A.id}`)[0]
  assert.equal((await h.call('clarify', r.body.job.id, { actionId: a.id, etapaId: 'agendado' })).body.job.status, 'concluido')
  assert.equal((await h.call('undo', a.id)).body.job.status, 'concluido')
  assert.equal(h.modelBodies.length, calls)
  assert.deepEqual((await h.sql`SELECT daily_jobs_reserved,daily_tokens_reserved FROM sac_operator_company_settings WHERE company_id=${h.A.id}`)[0], quota)
})
test('M05: request_json forjado para lead de outra empresa não atravessa o filtro de empresa', async () => {
  const p = await h.prepared([move()], 'Mova Mariana Souza para agendado')
  await h.sql`UPDATE sac_operator_actions
    SET request_json = jsonb_set(request_json, '{leadId}', to_jsonb(${h.leadB}::int), false)
    WHERE id=${p.actions[0].id}`
  const [forged] = await actions(p.jobId)
  const before = (await h.sql`SELECT to_jsonb(l) v FROM recovery_leads l WHERE id=${h.leadB}`)[0].v
  const result = await h.execute.executarAcao(h.actor(), p.jobId, forged)
  assert.equal(result.status, 'falhou')
  assert.deepEqual((await h.sql`SELECT to_jsonb(l) v FROM recovery_leads l WHERE id=${h.leadB}`)[0].v, before)
  assert.equal((await h.sql`SELECT pipeline_stage, context_version FROM recovery_leads WHERE id=${h.leadA}`)[0].pipeline_stage, null)
})
test('M11: a cota exata bloqueia o pedido seguinte antes de chamar o modelo', async () => {
  await h.sql`UPDATE sac_operator_company_settings SET max_jobs_per_day=1 WHERE company_id=${h.A.id}`
  plan([move()])
  assert.equal((await h.post('Mova Mariana Souza para agendado')).status, 202)
  const calls = h.modelBodies.length
  const blocked = await h.post('Anote Mariana Souza pediu retorno')
  assert.equal(blocked.status, 429)
  assert.equal(h.modelBodies.length, calls)
  assert.equal((await h.sql`SELECT daily_jobs_reserved FROM sac_operator_company_settings WHERE company_id=${h.A.id}`)[0].daily_jobs_reserved, 1)
})
test('T-IDEM-1/2: repetição sequencial e reexecução de recibo não repetem efeito', async () => {
  plan([move(), note()]); const key = randomUUID(); const r = await h.post(undefined, key); const again = await h.post(undefined, key)
  assert.equal(again.body.reused, true); assert.equal(again.body.job.id, r.body.job.id)
  const items = await actions(r.body.job.id)
  for (const a of items) assert.equal((await h.execute.executarAcao(h.actor(), r.body.job.id, a)).id, a.id)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE payload->>'jobId'=${r.body.job.id}`)[0].n, 2)
})
test('T-ATOM-1: falha de auditoria reverte CTE real de mover e anotar', async () => {
  await h.sql`CREATE FUNCTION qa_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failure'; END $$`
  await h.sql`CREATE TRIGGER qa_audit_fail BEFORE INSERT ON sac_audit_events FOR EACH ROW EXECUTE FUNCTION qa_audit_fail()`
  try {
    const before = await h.sql`SELECT to_jsonb(l) v FROM recovery_leads l WHERE id=${h.leadA}`
    const notes = (await h.sql`SELECT count(*)::int n FROM sac_internal_notes`)[0].n
    for (const type of [move(), note()]) {
      plan([type]); const r = await h.post(); assert.equal(r.body.job.status, 'falhou', JSON.stringify(r.body))
      assert.equal((await actions(r.body.job.id))[0].status, 'falhou')
      assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE payload->>'jobId'=${r.body.job.id}`)[0].n, 0)
    }
    assert.deepEqual(await h.sql`SELECT to_jsonb(l) v FROM recovery_leads l WHERE id=${h.leadA}`, before)
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_internal_notes`)[0].n, notes)
  } finally { await h.sql`DROP TRIGGER qa_audit_fail ON sac_audit_events`; await h.sql`DROP FUNCTION qa_audit_fail()` }
})
test('T-TRAVA1-B/D e T-TRAVA2-C: catálogo liberado e desfazeres não mudam pausa/envios em A e Isabela', async () => {
  const isabelaLead = await h.lead(h.I.id, 'Pessoa Teste')
  for (const [company, leadId] of [[h.A, h.leadA], [h.I, isabelaLead]] as const) {
    h.state.company = company
    const before = await h.protectedState()
    plan([move('agendado', '[T1]'), note('anotação', '[T1]')]); const r = await h.post(`Mova #${leadId} para agendado e anote anotação`)
    assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
    for (const a of await actions(r.body.job.id)) assert.equal((await h.call('undo', a.id)).body.job.status, 'concluido')
    for (const text of ['pause o bot', 'despause tudo']) { plan([{ type: 'recusar', motivo: 'controle_do_bot' }]); assert.match((await h.post(text)).body.job.resultText, /único controle do bot/) }
    plan([{ type: 'pausar_bot' }]); assert.equal((await h.post()).body.job.status, 'falhou')
    plan([{ type: 'criar_regra_instagram', gatilho: 'direct', palavra: '[T1]', mensagem: '[T2]', correspondencia: 'contem', ativar: true }]); assert.match((await h.post()).body.job.resultText, /Ainda não sei/)
    assert.equal(await h.protectedState(), before)
  }
})
test('cancelamento, expiração de esclarecimento e janela de sete dias', async () => {
  plan([move('chamada')]); const r = await h.post(); const [a] = await actions(r.body.job.id)
  assert.equal((await h.call('cancel', r.body.job.id)).body.job.status, 'cancelado')
  assert.equal((await h.call('clarify', r.body.job.id, { actionId: a.id, etapaId: 'agendado' })).status, 409)
  const r2 = await h.post(); const [a2] = await actions(r2.body.job.id)
  await h.sql`UPDATE sac_operator_jobs SET confirmation_expires_at=now()-interval '1 minute' WHERE id=${r2.body.job.id}`
  assert.equal((await h.call('clarify', r2.body.job.id, { actionId: a2.id, etapaId: 'agendado' })).status, 410)
  assert.equal((await actions(r2.body.job.id))[0].status, 'cancelado')
  plan([move()]); const r3 = await h.post(); const [a3] = await actions(r3.body.job.id)
  await h.sql`UPDATE sac_operator_jobs SET finished_at=now()-interval '8 days' WHERE id=${r3.body.job.id}`
  assert.equal((await h.call('undo', a3.id)).body.code, 'UNDO_WINDOW')
})
test('equivalência de etapa: PATCH pipeline/leads reais e catálogo válido, sem automação', async () => {
  const pipeline = await import('../src/app/api/pipeline/[leadId]/route')
  const leadRoute = await import('../src/app/api/leads/[leadId]/route')
  const [pId, lId] = await Promise.all([h.lead(h.A.id, 'Pipeline Teste'), h.lead(h.A.id, 'Legado Teste')])
  const before = await h.protectedState()
  assert.equal((await pipeline.PATCH(operatorRequest(`/api/pipeline/${pId}`, { stage: 'agendado' }), { params: Promise.resolve({ leadId: String(pId) }) })).status, 200)
  assert.equal((await leadRoute.PATCH(operatorRequest(`/api/leads/${lId}`, { stage: 'agendado' }), { params: Promise.resolve({ leadId: String(lId) }) })).status, 200)
  plan([move()]); assert.equal((await h.post()).body.job.status, 'concluido')
  const rows = await h.sql`SELECT id,pipeline_stage,context_version FROM recovery_leads WHERE id IN (${h.leadA},${pId},${lId})`
  assert.ok(rows.every(r => r.pipeline_stage === 'agendado'))
  assert.equal(rows.find(r => r.id === pId)!.context_version, rows.find(r => r.id === h.leadA)!.context_version)
  assert.equal((await pipeline.PATCH(operatorRequest(`/api/pipeline/${pId}`, { stage: 'inexistente' }), { params: Promise.resolve({ leadId: String(pId) }) })).status, 400)
  assert.equal(await h.protectedState(), before)
})

test('R6: interrupção após o primeiro efeito reconta recibos e não executa o restante', async () => {
  const p = await h.prepared([move(), note()], 'Mova Mariana Souza e anote pediu retorno amanhã')
  assert.equal((await h.execute.executarAcao(h.actor(), p.jobId, p.actions[0])).status, 'concluido')
  await h.sql`UPDATE sac_operator_jobs SET updated_at=now()-interval '11 minutes' WHERE id=${p.jobId}`
  const r = await h.call('get', p.jobId)
  assert.equal(r.body.job.errorCode, 'JOB_TIMEOUT')
  assert.deepEqual(r.body.job.resultJson.aplicadas, [p.actions[0].id])
  assert.deepEqual(r.body.job.resultJson.naoAplicadas, [p.actions[1].id])
  assert.match(r.body.job.resultText, /Executado:/); assert.match(r.body.job.resultText, /Não aplicado:/)
  const xminAfterFirstRead = (await h.sql`SELECT xmin::text FROM sac_operator_jobs WHERE id=${p.jobId}`)[0].xmin
  await h.call('get', p.jobId); await h.call('get', p.jobId)
  assert.equal((await h.sql`SELECT xmin::text FROM sac_operator_jobs WHERE id=${p.jobId}`)[0].xmin, xminAfterFirstRead)
  assert.equal((await h.execute.executarAcao(h.actor(), p.jobId, p.actions[1])).status, 'falhou')
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE payload->>'jobId'=${p.jobId}`)[0].n, 1)
})
