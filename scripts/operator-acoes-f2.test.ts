/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import { test, before, after, beforeEach, mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createOperatorAcoesHarness, type QaHarness } from './operator-acoes-harness'
let h: QaHarness
const permissions = ['buscar_lead','listar_etapas','listar_regras_instagram','mover_etapa','anotar_lead','criar_regra_instagram','editar_regra_instagram','ativar_regra_instagram','desativar_regra_instagram']
before(async () => { h = await createOperatorAcoesHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => {
  h.fresh()
  await h.sql`UPDATE sac_operator_company_settings SET enabled=true, kill_switch=false, allowed_actions=${h.sql.json(permissions)}, link_domains='[]', max_jobs_per_day=1000, daily_usage_date=NULL, daily_jobs_reserved=0, daily_tokens_reserved=0`
  await h.sql`DELETE FROM instagram_comment_logs`
  await h.sql`DELETE FROM instagram_comment_automations`
  await h.sql`DELETE FROM sac_operator_actions`
  await h.sql`DELETE FROM sac_operator_jobs`
  await h.sql`DELETE FROM sac_operator_locks`
})
function plan(actions: any[]) { h.state.plan = { actions, response: 'ok' } }
const create = (ativar = false, mensagem = '[LINK_1]') => ({ type: 'criar_regra_instagram', gatilho: 'comentario', palavra: '[PALAVRA_1]', mensagem, correspondencia: 'contem', ativar })
async function submit(word = 'CADERNO', ativar = false) {
  plan([create(ativar)])
  return h.post(`Crie regra palavra ${word} mensagem https://example.test/material`)
}
async function view(id: string) { return (await h.call('acoes', id)).body }
async function confirm(id: string, extra = {}) {
  const v = await view(id)
  return h.call('confirm', id, { planHash: v.job.planHash, codigo: v.acoes.find((a: any) => a.cartao)?.cartao.codigo ?? 'CADERNO', ...extra })
}
async function rule(word = 'CADERNO', active = false, company = h.A.id, extra = '') {
  return (await h.sql`INSERT INTO instagram_comment_automations (company_id,name,keywords,dm_message,is_active) VALUES (${company},'Painel',${word},${'Mensagem https://example.test/material' + extra},${active}) RETURNING id`)[0].id as number
}
async function change(type: string, id: number, fields = {}) {
  plan([{ type, regra: `#${id}`, ...fields }])
  return h.post(`Edite regra #${id} palavra NOVAPALAVRA mensagem https://example.test/novo`)
}

test('T-REGRA-1: criação inativa, global, campos seguros, recibo e auditoria atômicos', async () => {
  const existing = await rule('OUTRAPALAVRA')
  const prior = (await h.sql`SELECT to_jsonb(r) v FROM instagram_comment_automations r WHERE id=${existing}`)[0].v
  const r = await submit()
  assert.equal(r.status, 202); assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  const [row] = await h.sql`SELECT * FROM instagram_comment_automations WHERE keywords='CADERNO'`
  assert.ok(row); assert.equal(row.is_active, false); assert.equal(row.media_id, null); assert.equal(row.trigger_type, 'comment'); assert.equal(row.match_type, 'contains')
  for (const k of ['public_reply','auto_tag','media_url','media_caption','active_hours_start','active_hours_end','template_id']) assert.equal(row[k], null)
  for (const k of ['require_follow_check','hide_comment_after_reply','consent_required']) assert.equal(row[k], false)
  assert.deepEqual((await h.sql`SELECT to_jsonb(r) v FROM instagram_comment_automations r WHERE id=${existing}`)[0].v, prior)
  const [a] = await h.execute.acoesDoJob(h.A.id, r.body.job.id)
  assert.equal(a.afterSnapshot?.regra?.id, row.id)
  assert.equal(a.afterSnapshot?.regra?.updated_at, (await h.sql`SELECT updated_at::text v FROM instagram_comment_automations WHERE id=${row.id}`)[0].v)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE type='operator_rule_created' AND payload->>'jobId'=${r.body.job.id}`)[0].n, 1)
})
test('T-REGRA-2/T-CORPO-2: cartão 15 minutos, palavra e hash, confirmação única sem modelo', async () => {
  const n = h.modelBodies.length
  const r = await submit('CADERNO', true); const id = r.body.job.id
  assert.equal(r.body.job.waitingReason, 'confirmacao', JSON.stringify(r.body))
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 0)
  const v = await view(id)
  assert.ok(new Date(v.job.confirmationExpiresAt).getTime() - Date.now() > 890000)
  assert.match(v.acoes[0].cartao.avisos.join(' '), /Domínio não verificado/)
  assert.equal((await confirm(id, { codigo: 'errada' })).status, 400)
  assert.equal((await confirm(id, { planHash: '0'.repeat(64) })).body.code, 'PLAN_CHANGED')
  assert.equal((await confirm(id, { company_id: h.B.id })).status, 400)
  const done = await confirm(id, { codigo: 'cáderno' })
  assert.equal(done.status, 200); assert.equal(done.body.job.status, 'concluido', JSON.stringify(done.body))
  assert.equal((await h.sql`SELECT is_active FROM instagram_comment_automations`)[0].is_active, true)
  assert.equal((await confirm(id)).status, 409)
  assert.equal(h.modelBodies.length, n + 1)
})
test('12 confirmações simultâneas dão um efeito e uma auditoria', async () => {
  const r = await submit('CADERNO', true); const id = r.body.job.id; const v = await view(id)
  const replies = await Promise.all(Array.from({ length: 12 }, () => h.call('confirm', id, { planHash: v.job.planHash, codigo: 'CADERNO' })))
  assert.equal(replies.filter(r => r.status === 200).length, 1, JSON.stringify(replies))
  assert.equal(replies.filter(r => r.status === 409).length, 11)
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 1)
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_audit_events WHERE type='operator_card_confirmed' AND payload->>'jobId'=${id}`)[0].n, 1)
})
test('T-REGRA-3/4: duplicata sem caixa/acento e dois pedidos paralelos ficam em uma regra', async () => {
  plan([create()])
  const replies = await Promise.all([h.post('Crie regra palavra CADERNO mensagem https://example.test/material'), h.post('Crie regra palavra CADERNO mensagem https://example.test/material')])
  assert.equal(replies.filter(r => r.body.job?.status === 'concluido').length, 1, JSON.stringify(replies))
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 1)
  assert.equal((await submit('CÁDERNO')).body.code, 'RULE_EXISTS')
  await h.sql`UPDATE instagram_comment_automations SET is_active=true`
  assert.equal((await submit('caderno')).body.code, 'RULE_EXISTS')
})
test('T-REGRA-5/6: links de origem humana, HTTPS, domínio, palavra reservada e esquema fechado', async () => {
  for (const palavra of ['sim','quero','Luana','xy']) assert.equal((await submit(palavra)).body.code, 'INVALID_KEYWORD', palavra)
  plan([create(false, 'https://inventado.test')])
  assert.equal((await h.post('Crie regra palavra CADERNO')).body.code, 'LINK_NOT_FROM_USER')
  plan([create(false, 'ftp://example.test/material')]); assert.equal((await h.post('Crie regra palavra CADERNO')).body.code, 'INVALID_LINK')
  for (const link of ['http://example.test','https://user:pass@example.test','https://127.0.0.1','https://[::1]','https://localhost','https://2130706433']) {
    plan([create()]); assert.equal((await h.post(`Crie regra palavra CADERNO mensagem ${link}`)).body.code, 'INVALID_LINK', link)
  }
  await h.sql`UPDATE sac_operator_company_settings SET link_domains='["aprovado.test"]'`
  assert.equal((await submit()).body.code, 'LINK_DOMAIN_NOT_ALLOWED')
  plan([{ ...create(), correspondencia: 'any' }]); assert.equal((await h.post('Crie regra palavra CADERNO mensagem https://example.test')).body.job.status, 'falhou')
})
test('T-REGRA-7: edição só muda campos permitidos, ativa pede cartão, template recusa', async () => {
  const id = await rule()
  await h.sql`UPDATE instagram_comment_automations SET public_reply='Legado',require_follow_check=true,hide_comment_after_reply=true,auto_tag='legado' WHERE id=${id}`
  const before = (await h.sql`SELECT to_jsonb(r) v FROM instagram_comment_automations r WHERE id=${id}`)[0].v
  const r = await change('editar_regra_instagram', id, { novaPalavra: '[PALAVRA_1]', novaMensagem: '[LINK_1]', novaCorrespondencia: 'exata' })
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  const after = (await h.sql`SELECT to_jsonb(r) v FROM instagram_comment_automations r WHERE id=${id}`)[0].v
  assert.deepEqual(Object.keys(before).filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort(), ['keywords','dm_message','match_type','updated_at'].sort())
  await h.sql`UPDATE instagram_comment_automations SET is_active=true WHERE id=${id}`
  const active = await change('editar_regra_instagram', id, { novaMensagem: '[LINK_1]' }); assert.equal(active.body.job.waitingReason, 'confirmacao')
  assert.equal((await confirm(active.body.job.id)).body.job.status, 'concluido')
  await h.sql`UPDATE instagram_comment_automations SET template_id='021126' WHERE id=${id}`
  assert.equal((await change('editar_regra_instagram', id, { novaMensagem: '[LINK_1]' })).body.code, 'PROTECTED_RULE')
})
test('T-REGRA-8/10: sombra e alteração no painel são recusadas', async () => {
  const first = await rule('CADERNO', true); const id = await rule()
  assert.equal((await change('ativar_regra_instagram', id)).body.code, 'RULE_SHADOWED')
  await h.sql`UPDATE instagram_comment_automations SET keywords='',match_type='any' WHERE id=${first}`
  assert.equal((await change('ativar_regra_instagram', id)).body.code, 'RULE_SHADOWED')
  await h.sql`UPDATE instagram_comment_automations SET is_active=false WHERE id=${first}`
  const r = await change('ativar_regra_instagram', id)
  await h.sql`UPDATE instagram_comment_automations SET dm_message='Painel alterou',updated_at=now() WHERE id=${id}`
  const done = await confirm(r.body.job.id)
  assert.equal(done.body.job.errorCode, 'CONFLICT', JSON.stringify(done.body))
  assert.equal((await h.sql`SELECT is_active FROM instagram_comment_automations WHERE id=${id}`)[0].is_active, false)
})
test('T-REGRA-9: desativar regra do painel direto, Desfazer só reativa com cartão', async () => {
  const id = await rule('CADERNO', true)
  const r = await change('desativar_regra_instagram', id)
  assert.equal(r.body.job.status, 'concluido')
  const a = (await view(r.body.job.id)).acoes[0]
  const undo = await h.call('undo', a.id)
  assert.equal(undo.body.job.waitingReason, 'confirmacao', JSON.stringify(undo.body))
  assert.equal((await h.sql`SELECT is_active FROM instagram_comment_automations WHERE id=${id}`)[0].is_active, false)
  assert.equal((await confirm(undo.body.job.id)).body.job.status, 'concluido')
  assert.equal((await h.sql`SELECT is_active FROM instagram_comment_automations WHERE id=${id}`)[0].is_active, true)
  assert.equal((await h.call('undo', a.id)).body.reused, true)
})
test('T-UNDO-REGRA: apaga criação inativa intacta, preserva usada e não repete Desfazer', async () => {
  const r = await submit(); const a = (await view(r.body.job.id)).acoes[0]
  const u = await h.call('undo', a.id); assert.equal(u.body.job.status, 'concluido', JSON.stringify(u.body))
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 0)
  assert.equal((await h.call('undo', a.id)).body.reused, true)
  const used = await submit(); const [row] = await h.sql`SELECT id FROM instagram_comment_automations`
  await h.sql`INSERT INTO instagram_comment_logs (company_id,automation_id,comment_id,commenter_id,status) VALUES (${h.A.id},${row.id},'used','synthetic','sent')`
  const fail = await h.call('undo', (await view(used.body.job.id)).acoes[0].id)
  assert.equal(fail.body.job.errorCode, 'CONFLICT', JSON.stringify(fail.body))
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 1)
})
test('T-CARTAO-1: expiração cancela ações; cancelamento e confirmação paralelos têm um vencedor', async () => {
  const expired = await submit('CADERNO', true)
  await h.sql`UPDATE sac_operator_jobs SET confirmation_expires_at=now()-interval '1 second' WHERE id=${expired.body.job.id}`
  assert.equal((await confirm(expired.body.job.id)).status, 410)
  assert.equal((await h.execute.acoesDoJob(h.A.id, expired.body.job.id))[0].status, 'cancelado')
  const r = await submit('CADERNO', true); const v = await view(r.body.job.id)
  const result = await Promise.all([h.call('cancel', r.body.job.id), h.call('confirm', r.body.job.id, { planHash: v.job.planHash, codigo: 'CADERNO' })])
  assert.equal(result.filter(r => r.status === 200).length, 1)
  const final = await view(r.body.job.id)
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, final.job.status === 'concluido' ? 1 : 0)
})
test('T-CARTAO-2: ação direta espera junto com regra, inclusive após esclarecimento e apelido', async () => {
  await h.sql`UPDATE recovery_leads SET pipeline_stage=NULL WHERE id=${h.leadA}`
  plan([{ type: 'mover_etapa', lead: '[T1] [T2]', etapa: 'chamada' }, create(true)])
  const r = await h.post('Mova Mariana Souza para chamada e crie regra palavra CADERNO mensagem https://example.test/material')
  assert.equal(r.body.job.waitingReason, 'esclarecimento', JSON.stringify(r.body))
  const a = (await view(r.body.job.id)).acoes[0]
  const clarify = await h.call('clarify', r.body.job.id, { actionId: a.id, etapaId: 'agendado', lembrarApelido: true })
  assert.equal(clarify.body.job.waitingReason, 'confirmacao', JSON.stringify(clarify.body))
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${h.leadA}`)[0].pipeline_stage, null)
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 0)
  const done = await confirm(r.body.job.id); assert.equal(done.body.job.status, 'concluido', JSON.stringify(done.body))
  assert.equal((await h.sql`SELECT pipeline_stage FROM recovery_leads WHERE id=${h.leadA}`)[0].pipeline_stage, 'agendado')
})
test('Travas de sessão/admin/IDOR/CSRF/desligado/kill/permissão; mesma regra para todas as empresas', async () => {
  const r = await submit('CADERNO', true); const id = r.body.job.id; const v = await view(id)
  const body = { planHash: v.job.planHash, codigo: 'CADERNO' }
  h.state.mode = 'member'; assert.equal((await h.call('confirm', id, body)).status, 403)
  h.state.mode = 'agent'; assert.equal((await h.call('confirm', id, body)).status, 401)
  h.state.mode = 'none'; assert.equal((await h.call('confirm', id, body)).status, 401)
  h.fresh(); h.state.company = h.B; assert.equal((await h.call('confirm', id, body)).status, 404)
  h.fresh(); assert.equal((await h.call('confirm', id, body, { origin: 'https://evil.test' })).status, 403)
  await h.sql`UPDATE sac_operator_company_settings SET enabled=false WHERE company_id=${h.A.id}`
  assert.equal((await h.call('confirm', id, body)).status, 403)
  await h.sql`UPDATE sac_operator_company_settings SET enabled=true,kill_switch=true WHERE company_id=${h.A.id}`
  assert.equal((await h.call('confirm', id, body)).status, 403)
  await h.sql`UPDATE sac_operator_company_settings SET kill_switch=false,allowed_actions='["criar_regra_instagram"]' WHERE company_id=${h.A.id}`
  assert.equal((await h.call('confirm', id, body)).body.job.errorCode, 'GATE_CLOSED')
  h.fresh(); h.state.company = h.I
  const isabela = await submit('CADERNO', true); assert.equal((await confirm(isabela.body.job.id)).body.job.status, 'concluido')
})
test('PII no corpo real do modelo e nenhuma escrita de pausa ou envio nas ações', async () => {
  const snapshot = async () => JSON.stringify({ pauses: await h.sql`SELECT * FROM company_pause_switches ORDER BY id`, leads: await h.sql`SELECT to_jsonb(r) v FROM recovery_leads r ORDER BY id`, settings: await h.sql`SELECT * FROM settings ORDER BY id`, messages: await h.sql`SELECT count(*) n FROM whatsapp_messages`, jobs: await h.sql`SELECT count(*) n FROM message_jobs`, logs: await h.sql`SELECT count(*) n FROM instagram_comment_logs`, story: await h.sql`SELECT count(*) n FROM instagram_story_deliveries` })
  const before = await snapshot()
  plan([create(true, '[T1] [T2] [CONTATO_1] [CONTATO_2] [LINK_1]')])
  const r = await h.post('Crie regra palavra CADERNO mensagem Mariana Souza mariana@example.test 11999998888 https://example.test/material')
  assert.equal(r.body.job.waitingReason, 'confirmacao', JSON.stringify(r.body))
  const body = h.modelBodies.at(-1); assert.equal(body.messages.length, 2)
  assert.doesNotMatch(JSON.stringify(body), /Mariana|Souza|CADERNO|11999998888|mariana@example|https:\/\/example/)
  assert.equal((await confirm(r.body.job.id)).body.job.status, 'concluido')
  for (const type of ['pausar_bot','pause_all','enviar_dm','ligar_bot']) { h.fresh(); plan([{ type }]); assert.equal((await h.post('Despause o bot e envie mensagem')).body.job.status, 'falhou') }
  assert.equal(await snapshot(), before)
  assert.equal(h.externalCalls.length, 0)
})
test('Cota de criação revalidada sob lock e cota de pedidos antes do modelo', async () => {
  for (let i = 0; i < 10; i++) { h.fresh(); const r = await submit(`CADERNO${i}`); assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body)) }
  h.fresh(); assert.equal((await submit('CADERNOEXTRA')).body.code, 'DAILY_RULE_LIMIT')
  await h.sql`UPDATE sac_operator_company_settings SET max_jobs_per_day=1 WHERE company_id=${h.A.id}`
  const before = h.modelBodies.length
  assert.equal((await submit('CADERNOOUTRO')).status, 429)
  assert.equal(h.modelBodies.length, before)
})
test('Regra ambígua exige opção oferecida; alvo de outra empresa e marcador inventado recusados', async () => {
  const a = await rule('CADERNO'); await rule('CADERNO')
  plan([{ type: 'desativar_regra_instagram', regra: '[PALAVRA_1]' }])
  const r = await h.post('Desative regra palavra CADERNO'); assert.equal(r.body.job.waitingReason, 'esclarecimento')
  const v = await view(r.body.job.id); const foreign = await rule('PRIVADA', true, h.B.id)
  assert.equal((await h.call('clarify', r.body.job.id, { actionId: v.acoes[0].id, ruleId: foreign })).status, 400)
  assert.equal((await h.call('clarify', r.body.job.id, { actionId: v.acoes[0].id, ruleId: a })).body.job.status, 'concluido')
  assert.equal((await change('desativar_regra_instagram', foreign)).status, 404)
  plan([{ ...create(), palavra: '[PALAVRA_99]' }]); assert.equal((await h.post('Crie regra palavra CADERNO mensagem https://example.test')).body.code, 'MARKER_UNKNOWN')
})
test('Migração 0046 duas vezes preserva information_schema; aplicador exige alvo e confirmação', async () => {
  const snapshot = async () => await h.sql`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name,ordinal_position`
  const before = await snapshot(); const migration = readFileSync('drizzle/0046_sac_operator_locks.sql', 'utf8')
  await h.sql.unsafe(migration); await h.sql.unsafe(migration)
  assert.deepEqual(await snapshot(), before)
  const run = (args: string[], env = {}) => spawnSync(process.execPath, ['--import','tsx','scripts/operator-apply-migration-0046.ts', ...args], { encoding: 'utf8', env: { ...process.env, OPERATOR_MIGRATION_CONFIRM:'', OPERATOR_MIGRATION_ALLOW_REMOTE:'', OPERATOR_MIGRATION_DATABASE_URL:'', OPERATOR_MIGRATION_EXPECTED_DATABASE:'', ...env } })
  assert.equal(run([]).status, 0)
  assert.equal(run(['--apply']).status, 1)
  assert.match(run(['--apply'], { OPERATOR_MIGRATION_CONFIRM:'sim', OPERATOR_MIGRATION_DATABASE_URL:'postgres://a:b@127.0.0.1:1/errado', OPERATOR_MIGRATION_EXPECTED_DATABASE:'test' }).stderr, /não corresponde/)
  assert.match(run(['--apply'], { OPERATOR_MIGRATION_CONFIRM:'sim', OPERATOR_MIGRATION_DATABASE_URL:'postgres://a:b@remote.test/test', OPERATOR_MIGRATION_EXPECTED_DATABASE:'test' }).stderr, /remoto bloqueado/)
  assert.equal(run(['--apply'], { OPERATOR_MIGRATION_CONFIRM:'sim', OPERATOR_MIGRATION_DATABASE_URL:'postgres://postgres:test@127.0.0.1:55433/test', OPERATOR_MIGRATION_EXPECTED_DATABASE:'test' }).status, 0)
  assert.deepEqual(await snapshot(), before)
})

test('T-PROC-1: processador real ignora inativa, regra ativa alcança somente a armadilha Graph', async () => {
  // Somente fixtures locais: o teste do processador desliga a pausa local diretamente.
  const r = await submit()
  assert.equal(r.body.job.status, 'concluido')
  const [row] = await h.sql`SELECT id FROM instagram_comment_automations`
  const { processInstagramComment } = await import('../src/lib/instagram-comment-processor')
  const event = { companyId: h.A.id, commentId: 'f2-comment', commenterId: 'f2-viewer', mediaId: 'f2-media', commentText: 'cáderno!', source: 'instagram_webhook' as const, commentCreatedAt: new Date() }
  const calls: Array<{ url: string; body: any }> = []
  const trap = mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) }); throw new Error('Armadilha local, nenhum envio real') })
  try {
    assert.equal((await processInstagramComment(event)).status, 'skipped'); assert.equal(calls.length, 0)
  } finally { trap.mock.restore() }
  const active = await change('ativar_regra_instagram', row.id); assert.equal((await confirm(active.body.job.id)).body.job.status, 'concluido')
  await h.sql`UPDATE company_pause_switches SET active=false WHERE company_id=${h.A.id}`
  await h.sql`UPDATE settings SET instagram_access_token='stub-local',instagram_account_id='stub-account' WHERE company_id=${h.A.id}`
  const sendTrap = mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) }); throw new Error('Armadilha local, nenhum envio real') })
  try {
    assert.equal((await processInstagramComment(event)).status, 'failed')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://graph.instagram.com/v21.0/stub-account/messages')
    assert.equal(calls[0].body.message.text, 'https://example.test/material')
    assert.equal((await h.sql`SELECT automation_id FROM instagram_comment_logs WHERE comment_id='f2-comment'`)[0].automation_id, row.id)
  } finally { sendTrap.mock.restore() }
})

test('Regra já ativa confirma sem efeito; Desfazer de edição ativa também exige cartão', async () => {
  const id = await rule('CADERNO', true)
  const r = await change('ativar_regra_instagram', id)
  const before = (await h.sql`SELECT updated_at::text v FROM instagram_comment_automations WHERE id=${id}`)[0].v
  const done = await confirm(r.body.job.id); assert.equal(done.body.job.status, 'concluido')
  assert.equal((await h.sql`SELECT updated_at::text v FROM instagram_comment_automations WHERE id=${id}`)[0].v, before)
  assert.equal(done.body.acoes[0].podeDesfazer, false)
  const edit = await change('editar_regra_instagram', id, { novaMensagem: '[LINK_1]' }); assert.equal((await confirm(edit.body.job.id)).body.job.status, 'concluido')
  const undo = await h.call('undo', (await view(edit.body.job.id)).acoes[0].id)
  assert.equal(undo.body.job.waitingReason, 'confirmacao')
  assert.equal((await confirm(undo.body.job.id)).body.job.status, 'concluido')
  assert.equal((await h.sql`SELECT dm_message FROM instagram_comment_automations WHERE id=${id}`)[0].dm_message, 'Mensagem https://example.test/material')
})

test('Lock ocupado/expirado e atomicidade: auditoria rejeitada reverte criação e edição', async () => {
  await h.sql`INSERT INTO sac_operator_locks (company_id,holder,locked_until) VALUES (${h.A.id},${randomUUID()},now()+interval '1 minute')`
  const busy = await submit(); assert.equal(busy.body.job.errorCode, 'BUSY')
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 0)
  await h.sql`UPDATE sac_operator_locks SET locked_until=now()-interval '1 second'`
  const r = await submit(); assert.equal(r.body.job.status, 'concluido')
  assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_locks`)[0].n, 0)
  await h.sql.unsafe(`CREATE FUNCTION qa_reject_rule_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type LIKE 'operator_rule_%' THEN RETURN NULL; END IF; RETURN NEW; END $$`)
  await h.sql`CREATE TRIGGER qa_reject_rule_audit BEFORE INSERT ON sac_audit_events FOR EACH ROW EXECUTE FUNCTION qa_reject_rule_audit()`
  try {
    assert.equal((await submit('OUTRAPALAVRA')).body.job.errorCode, 'OPERATOR_INCONSISTENT')
    const [row] = await h.sql`SELECT id FROM instagram_comment_automations`
    const before = (await h.sql`SELECT to_jsonb(r) v FROM instagram_comment_automations r WHERE id=${row.id}`)[0].v
    assert.equal((await change('editar_regra_instagram', row.id, { novaMensagem: '[LINK_1]' })).body.job.errorCode, 'OPERATOR_INCONSISTENT')
    assert.deepEqual((await h.sql`SELECT to_jsonb(r) v FROM instagram_comment_automations r WHERE id=${row.id}`)[0].v, before)
    assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 1)
  } finally {
    await h.sql`DROP TRIGGER qa_reject_rule_audit ON sac_audit_events`
    await h.sql`DROP FUNCTION qa_reject_rule_audit()`
  }
})

test('Leitura de story do perfil Fatia 2 respeita empresa; escrita permanece recusada', async () => {
  await h.sql`UPDATE sac_operator_company_settings SET allowed_actions=allowed_actions || '["listar_regras_story"]'::jsonb WHERE company_id=${h.A.id}`
  await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message,is_active,mode) VALUES (${h.A.id},'Visível',ARRAY['PUBLICO'],'Texto',false,'observe'),(${h.B.id},'Privada',ARRAY['PRIVADO'],'Texto',false,'observe')`
  plan([{ type: 'listar_regras_story' }])
  const r = await h.post('Liste regras de story')
  assert.equal(r.body.job.status, 'concluido')
  const data = r.body.job.resultJson.results[0].data
  assert.equal(data.length, 1); assert.equal(data[0].name, 'Visível')
  plan([{ type: 'criar_regra_story', palavra: '[PALAVRA_1]', mensagem: '[LINK_1]', correspondencia: 'contem', ativar: 'envio' }])
  assert.match((await h.post('Crie regra story palavra CADERNO mensagem https://example.test')).body.job.resultText, /Ainda não sei/)
})

test('Mensagem humana entre aspas resolve link aninhado no servidor; palavra de dois caracteres aceita em exata', async () => {
  plan([create(false, '[PALAVRA_1]')])
  // Aspas são anonimizadas antes da extração de palavra-chave: mensagem #1, palavra #2.
  h.state.plan = { actions: [{ ...create(false, '[PALAVRA_1]'), palavra: '[PALAVRA_2]' }], response: 'ok' }
  const r = await h.post('Crie regra palavra CADERNO mensagem "Olá, veja https://example.test/material"')
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  assert.equal((await h.sql`SELECT dm_message FROM instagram_comment_automations`)[0].dm_message, 'Olá, veja https://example.test/material')
  const id = await rule('AB')
  await h.sql`UPDATE instagram_comment_automations SET match_type='exact' WHERE id=${id}`
  plan([{ type: 'editar_regra_instagram', regra: `#${id}`, novaPalavra: '[PALAVRA_1]' }])
  assert.equal((await h.post(`Edite regra #${id} palavra CD`)).body.job.status, 'concluido')
})

test('Any inativa não impede criação; gate SQL impede executar cartão sem confirmação humana', async () => {
  await h.sql`INSERT INTO instagram_comment_automations (company_id,name,keywords,match_type,dm_message,is_active) VALUES (${h.A.id},'Qualquer inativa','','any','Texto',false)`
  const r = await submit(); assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  const p = await h.prepared([create(true)], 'Crie regra palavra OUTRAPALAVRA mensagem https://example.test')
  const result = await h.execute.executarJob(h.actor(), p.jobId)
  assert.equal(result[0].afterSnapshot?.erro, 'GATE_CLOSED')
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations WHERE keywords='OUTRAPALAVRA'`)[0].n, 0)
})

test('Desfazer de criação ativa só desativa se ainda não disparou; não admin e outra empresa recusam undo', async () => {
  const r = await submit('CADERNO', true); assert.equal((await confirm(r.body.job.id)).body.job.status, 'concluido')
  const a = (await view(r.body.job.id)).acoes[0]
  h.state.mode = 'member'; assert.equal((await h.call('undo', a.id)).status, 403)
  h.fresh(); h.state.company = h.B; assert.equal((await h.call('undo', a.id)).status, 404)
  h.fresh(); const undone = await h.call('undo', a.id); assert.equal(undone.body.job.status, 'concluido')
  assert.equal((await h.sql`SELECT is_active FROM instagram_comment_automations WHERE keywords='CADERNO'`)[0].is_active, false)
  const used = await submit('OUTRAPALAVRA', true); assert.equal((await confirm(used.body.job.id)).body.job.status, 'concluido')
  const [row] = await h.sql`SELECT id FROM instagram_comment_automations WHERE keywords='OUTRAPALAVRA'`
  await h.sql`INSERT INTO instagram_comment_logs (company_id,automation_id,comment_id,commenter_id,status) VALUES (${h.A.id},${row.id},'used-active','synthetic','sent')`
  assert.equal((await h.call('undo', (await view(used.body.job.id)).acoes[0].id)).body.job.errorCode, 'CONFLICT')
  assert.equal((await h.sql`SELECT is_active FROM instagram_comment_automations WHERE id=${row.id}`)[0].is_active, true)
})

test('Desativar reduz envio de qualquer regra legada; reativar Direct/ambos permanece na Fatia 3', async () => {
  for (const trigger of ['direct', 'both']) {
    const id = await rule(`PALAVRA${trigger}`, true)
    await h.sql`UPDATE instagram_comment_automations SET trigger_type=${trigger} WHERE id=${id}`
    const r = await change('desativar_regra_instagram', id)
    assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
    assert.equal((await h.sql`SELECT is_active FROM instagram_comment_automations WHERE id=${id}`)[0].is_active, false)
    const a = (await view(r.body.job.id)).acoes[0]; assert.equal(a.podeDesfazer, false)
    assert.equal((await h.call('undo', a.id)).body.code, 'NOT_UNDOABLE')
    assert.equal((await change('ativar_regra_instagram', id)).body.code, 'NOT_AVAILABLE')
  }
})

test('Migração ausente falha fechado em preparo e confirmação, sem efeito', async () => {
  const r = await submit('CADERNO', true); const v = await view(r.body.job.id)
  await h.sql`DROP TABLE sac_operator_locks`
  try {
    assert.equal((await h.call('confirm', r.body.job.id, { planHash: v.job.planHash, codigo: 'CADERNO' })).status, 403)
    assert.equal((await submit('OUTRAPALAVRA')).body.code, 'DISABLED')
    assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 0)
  } finally { await h.sql.unsafe(readFileSync('drizzle/0046_sac_operator_locks.sql', 'utf8')) }
})

test('Cartão misto aceita movimento sem efeito; Desfazer mostra domínios da mensagem restaurada', async () => {
  await h.sql`UPDATE recovery_leads SET pipeline_stage='agendado' WHERE id=${h.leadA}`
  plan([{ type: 'mover_etapa', lead: '[T1] [T2]', etapa: 'agendado' }, create(true)])
  const r = await h.post('Mova Mariana Souza para agendado e crie regra palavra CADERNO mensagem https://example.test/material')
  assert.equal((await confirm(r.body.job.id)).body.job.status, 'concluido')
  const id = await rule('RESTAURAR', true)
  await h.sql`UPDATE instagram_comment_automations SET dm_message='https://original.test/material' WHERE id=${id}`
  const edit = await change('editar_regra_instagram', id, { novaMensagem: '[LINK_1]' }); assert.equal((await confirm(edit.body.job.id)).body.job.status, 'concluido')
  const undo = await h.call('undo', (await view(edit.body.job.id)).acoes[0].id)
  const card = (await view(undo.body.job.id)).acoes[0].cartao
  assert.deepEqual(card.dominios, ['original.test'])
  assert.match(card.avisos.join(' '), /Domínio não verificado: original.test/)
  assert.equal((await confirm(undo.body.job.id)).body.job.status, 'concluido')
})

test('Inserção do painel entre verificação e efeito refaz conflito uma vez e não deixa recibo órfão', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core')
  const dialect = new PgDialect()
  const execute = h.db.execute.bind(h.db)
  let inserted = false
  const spy = mock.method(h.db, 'execute', async (query: any) => {
    const text = dialect.sqlToQuery(query).sql
    if (!inserted && text.includes('clm AS') && text.includes('INSERT INTO instagram_comment_automations')) {
      inserted = true
      await rule('CADERNO')
    }
    return execute(query)
  })
  try {
    const r = await submit()
    assert.equal(inserted, true)
    assert.equal(r.body.job.errorCode, 'RULE_EXISTS', JSON.stringify(r.body))
    assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 1)
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions WHERE job_id=${r.body.job.id} AND status='concluido'`)[0].n, 0)
  } finally { spy.mock.restore() }
})
