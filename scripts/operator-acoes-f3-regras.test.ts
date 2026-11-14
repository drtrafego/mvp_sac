/* Cobertura comportamental da Fatia 3. O banco usado aqui é o Postgres real do
 * harness; os testes não iniciam um segundo container. */
/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict'
import { before, after, beforeEach, test, mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createOperatorAcoesHarness, type QaHarness } from './operator-acoes-harness'

let h: QaHarness
const permissions = [
  'buscar_lead', 'listar_etapas', 'listar_regras_instagram', 'listar_regras_story',
  'mover_etapa', 'anotar_lead', 'criar_regra_instagram', 'editar_regra_instagram',
  'ativar_regra_instagram', 'desativar_regra_instagram', 'criar_regra_story',
  'editar_regra_story', 'ativar_regra_story', 'desativar_regra_story', 'mover_etapa_lote',
]

before(async () => { h = await createOperatorAcoesHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => {
  h.fresh()
  await h.sql`UPDATE sac_operator_company_settings SET enabled=true, kill_switch=false,
    allowed_actions=${h.sql.json(permissions)}, link_domains='[]', max_jobs_per_day=1000,
    daily_usage_date=NULL, daily_jobs_reserved=0, daily_tokens_reserved=0`
  await h.sql`DELETE FROM instagram_story_deliveries`
  await h.sql`DELETE FROM instagram_story_automations`
  await h.sql`DELETE FROM instagram_comment_automations`
  await h.sql`DELETE FROM sac_operator_actions`
  await h.sql`DELETE FROM sac_operator_jobs`
  await h.sql`DELETE FROM sac_operator_locks`
})

function plan(actions: any[]) { h.state.plan = { actions, response: 'ok' } }
function direct(gatilho: 'direct' | 'ambos' = 'direct', ativar = false) {
  return { type: 'criar_regra_instagram', gatilho, palavra: '[PALAVRA_1]', mensagem: '[LINK_1]', correspondencia: 'contem', ativar }
}
function story(ativar: 'nao' | 'teste' | 'envio' = 'nao') {
  return { type: 'criar_regra_story', palavra: '[PALAVRA_1]', mensagem: '[LINK_1]', correspondencia: 'contem', ativar }
}
async function view(id: string) { return (await h.call('acoes', id)).body }
async function confirm(id: string, code = 'CADERNO', knownView?: any) {
  const v = knownView ?? await view(id)
  return h.call('confirm', id, { planHash: v.job.planHash, codigo: code })
}
async function createRule(word: string, trigger = 'direct', active = false, company = h.A.id) {
  return (await h.sql`INSERT INTO instagram_comment_automations
    (company_id,name,keywords,match_type,dm_message,trigger_type,is_active)
    VALUES (${company},'QA',${word},'contains','Mensagem https://example.test/x',${trigger},${active}) RETURNING id`)[0].id as number
}

test('F3-DIRECT-1: criação Direct nasce inativa e mantém o gatilho direct', async () => {
  plan([direct('direct')])
  const r = await h.post('Crie regra Direct palavra CADERNO mensagem https://example.test/x')
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  const [row] = await h.sql`SELECT trigger_type,is_active,keywords,match_type FROM instagram_comment_automations`
  assert.deepEqual(row, { trigger_type: 'direct', is_active: false, keywords: 'CADERNO', match_type: 'contains' })
})

test('F3-DIRECT-2: criação ambos nasce inativa e alcança comentário e Direct', async () => {
  plan([direct('ambos')])
  const r = await h.post('Crie regra ambos palavra CADERNO mensagem https://example.test/x')
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  assert.equal((await h.sql`SELECT trigger_type,is_active FROM instagram_comment_automations`)[0].trigger_type, 'both')
  assert.equal((await h.sql`SELECT is_active FROM instagram_comment_automations`)[0].is_active, false)
})

test('F3-DIRECT-3: ativar no pedido exige cartão e não escreve antes da confirmação', async () => {
  plan([direct('direct', true)])
  const r = await h.post('Crie regra Direct palavra CADERNO mensagem https://example.test/x e ative')
  assert.equal(r.body.job.waitingReason, 'confirmacao', JSON.stringify(r.body))
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 0)
  assert.match((await view(r.body.job.id)).acoes[0].cartao.avisos.join(' '), /Direct/i)
  assert.equal((await confirm(r.body.job.id, 'CADERNO')).status, 200)
  assert.equal((await h.sql`SELECT is_active FROM instagram_comment_automations`)[0].is_active, true)
})

test('F3-DIRECT-4: regra Direct existente pode ser editada sem trocar seu trigger', async () => {
  const id = await createRule('CADERNO', 'direct')
  plan([{ type: 'editar_regra_instagram', regra: '[PALAVRA_1]', novaPalavra: '[PALAVRA_1]' }])
  const r = await h.post('Edite a regra "CADERNO" para a palavra CADERNO')
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  assert.equal((await h.sql`SELECT trigger_type,keywords FROM instagram_comment_automations WHERE id=${id}`)[0].trigger_type, 'direct')
})

test('F3-DIRECT-5: editar Direct ativo exige cartão', async () => {
  await createRule('CADERNO', 'direct', true)
  plan([{ type: 'editar_regra_instagram', regra: '[PALAVRA_1]', novaMensagem: '[LINK_1]' }])
  const r = await h.post('Edite a regra "CADERNO" mensagem https://example.test/y')
  assert.equal(r.body.job.waitingReason, 'confirmacao', JSON.stringify(r.body))
})

test('F3-DIRECT-6: ativação por regra não permite ID de outra empresa', async () => {
  const id = await createRule('CADERNO', 'direct', false, h.B.id)
  plan([{ type: 'ativar_regra_instagram', regra: `#${id}` }])
  const r = await h.post(`Ative a regra #${id}`)
  assert.equal(r.status, 404)
  assert.equal((await h.sql`SELECT is_active FROM instagram_comment_automations WHERE id=${id}`)[0].is_active, false)
})

test('F3-DIRECT-7: conflito entre palavras em Direct e ambos é recusado', async () => {
  await createRule('CADERNO', 'direct', true)
  plan([direct('ambos')])
  const r = await h.post('Crie regra ambos palavra CADERNO mensagem https://example.test/x')
  assert.equal(r.body.code ?? r.body.job?.errorCode, 'RULE_EXISTS')
})

test('F3-DIRECT-8: duplicata ignora caixa e acento', async () => {
  await createRule('CADERNO', 'both', false)
  plan([direct('direct')])
  const r = await h.post('Crie regra Direct palavra cáderno mensagem https://example.test/x')
  assert.equal(r.body.code, 'RULE_EXISTS')
})

test('F3-DIRECT-9: desativar regra Direct é direto e preserva a configuração', async () => {
  const id = await createRule('CADERNO', 'direct', true)
  plan([{ type: 'desativar_regra_instagram', regra: `#${id}` }])
  const r = await h.post(`Desative a regra #${id}`)
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  assert.deepEqual((await h.sql`SELECT trigger_type,is_active,keywords FROM instagram_comment_automations WHERE id=${id}`)[0], { trigger_type: 'direct', is_active: false, keywords: 'CADERNO' })
})

test('F3-DIRECT-10: cartão errado, hash errado e repetido não ativam duas vezes', async () => {
  plan([direct('direct', true)])
  const r = await h.post('Crie regra Direct palavra CADERNO mensagem https://example.test/x e ative')
  const id = r.body.job.id
  assert.equal((await confirm(id, 'errada')).status, 400)
  assert.equal((await h.call('confirm', id, { planHash: '0'.repeat(64), codigo: 'CADERNO' })).body.code, 'PLAN_CHANGED')
  assert.equal((await confirm(id)).status, 200)
  assert.equal((await confirm(id)).status, 409)
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 1)
})

test('F3-DIRECT-11: membro, sessão ausente e empresa desligada não alteram regra', async () => {
  plan([direct('direct')])
  h.state.mode = 'member'; assert.equal((await h.post()).status, 403)
  h.state.mode = 'none'; assert.equal((await h.post()).status, 401)
  h.fresh(); await h.sql`UPDATE sac_operator_company_settings SET enabled=false WHERE company_id=${h.A.id}`
  assert.equal((await h.post()).status, 403)
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations`)[0].n, 0)
})

test('F3-DIRECT-12: texto e link não vazam PII para o modelo', async () => {
  plan([direct('direct')])
  const r = await h.post('Crie regra Direct palavra CADERNO mensagem https://example.test/segredo para Mariana Souza 5511988887777')
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  assert.doesNotMatch(JSON.stringify(h.modelBodies), /Mariana|Souza|5511988887777/)
  const [saved] = await h.sql`SELECT keywords,dm_message,trigger_type,is_active FROM instagram_comment_automations`
  assert.equal(saved.keywords, 'CADERNO'); assert.equal(saved.trigger_type, 'direct'); assert.equal(saved.is_active, false)
  assert.match(saved.dm_message, /https:\/\/example\.test\/segredo/)
})

test('F3-STORY-1: criação de story nasce inativa e em observe', async () => {
  plan([story('nao')])
  const r = await h.post('Crie regra de story palavra CADERNO mensagem https://example.test/x')
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  const [row] = await h.sql`SELECT is_active,mode,keywords,match_type FROM instagram_story_automations`
  assert.equal(row.is_active, false); assert.equal(row.mode, 'observe'); assert.equal(row.keywords[0], 'CADERNO'); assert.equal(row.match_type, 'contains')
})

test('F3-STORY-2: story teste nasce inativa em observe e pede ativação separada', async () => {
  plan([story('teste')])
  const r = await h.post('Crie regra de story em teste palavra CADERNO mensagem https://example.test/x')
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  const row = (await h.sql`SELECT is_active,mode FROM instagram_story_automations`)[0]
  assert.equal(row.is_active, false); assert.equal(row.mode, 'observe')
})

test('F3-STORY-3: story envio aguarda cartão separado com texto e aviso de alcance', async () => {
  plan([story('envio')])
  const r = await h.post('Crie regra de story em envio palavra CADERNO mensagem https://example.test/x')
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  const [row] = await h.sql`SELECT id,is_active,mode FROM instagram_story_automations`
  assert.equal(row.is_active, false); assert.equal(row.mode, 'observe')
  plan([{ type: 'ativar_regra_story', regra: `#${row.id}`, modo: 'envio' }])
  const activation = await h.post(`Ative a regra de story #${row.id} em envio`)
  assert.equal(activation.body.job.waitingReason, 'confirmacao', JSON.stringify(activation.body))
  const card = (await view(activation.body.job.id)).acoes[0].cartao
  assert.match(card.mensagem, /https:\/\/example\.test\/x|LINK_1/)
  assert.match(card.avisos.join(' '), /qualquer story/i)
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_automations`)[0].n, 1)
})

test('F3-STORY-4: confirmar envio torna a regra ativa em mode send', async () => {
  plan([story('envio')])
  const r = await h.post('Crie regra de story em envio palavra CADERNO mensagem https://example.test/x')
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  const [row] = await h.sql`SELECT id FROM instagram_story_automations`
  plan([{ type: 'ativar_regra_story', regra: `#${row.id}`, modo: 'envio' }])
  const activation = await h.post(`Ative a regra de story #${row.id} em envio`)
  assert.equal((await confirm(activation.body.job.id)).status, 200)
  assert.deepEqual((await h.sql`SELECT is_active,mode FROM instagram_story_automations`)[0], { is_active: true, mode: 'send' })
})

test('F3-STORY-5: editar story observe não ativa e preserva mode', async () => {
  const [id] = await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,match_type,dm_message,is_active,mode) VALUES (${h.A.id},'QA',ARRAY['CADERNO'],'contains','Texto',false,'observe') RETURNING id`
  plan([{ type: 'editar_regra_story', regra: `#${id.id}`, novaPalavra: '[PALAVRA_1]' }])
  const r = await h.post(`Edite a regra de story #${id.id} para palavra NOVA`)
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body))
  const changed = (await h.sql`SELECT keywords,is_active,mode FROM instagram_story_automations WHERE id=${id.id}`)[0]
  assert.equal(changed.keywords[0], 'NOVA'); assert.equal(changed.is_active, false); assert.equal(changed.mode, 'observe')
})

test('F3-STORY-6: ativar story em teste executa direto e mantém observe', async () => {
  const [id] = await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,match_type,dm_message,is_active,mode) VALUES (${h.A.id},'QA',ARRAY['CADERNO'],'contains','Texto',false,'observe') RETURNING id`
  plan([{ type: 'ativar_regra_story', regra: `#${id.id}`, modo: 'teste' }])
  const r = await h.post(`Ative a regra de story #${id.id} em teste`)
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body)); assert.equal((await h.sql`SELECT is_active,mode FROM instagram_story_automations WHERE id=${id.id}`)[0].mode, 'observe')
})

test('F3-STORY-7: ativar story em envio exige confirmação explícita', async () => {
  const [id] = await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,match_type,dm_message,is_active,mode) VALUES (${h.A.id},'QA',ARRAY['CADERNO'],'contains','Texto',true,'observe') RETURNING id`
  plan([{ type: 'ativar_regra_story', regra: `#${id.id}`, modo: 'envio' }])
  const r = await h.post(`Ative a regra de story #${id.id} em envio`)
  assert.equal(r.body.job.waitingReason, 'confirmacao', JSON.stringify(r.body)); assert.equal((await h.sql`SELECT mode FROM instagram_story_automations WHERE id=${id.id}`)[0].mode, 'observe')
})

test('F3-STORY-8: desativar story é direto e não apaga histórico', async () => {
  const [id] = await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,match_type,dm_message,is_active,mode) VALUES (${h.A.id},'QA',ARRAY['CADERNO'],'contains','Texto',true,'send') RETURNING id`
  await h.sql`INSERT INTO instagram_story_deliveries (company_id,automation_id,sender_id,story_id,occurred_at,status) VALUES (${h.A.id},${id.id},'sender','story',now(),'observed')`
  plan([{ type: 'desativar_regra_story', regra: `#${id.id}` }])
  const r = await h.post(`Desative a regra de story #${id.id}`)
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body)); assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_deliveries`)[0].n, 1)
})

test('F3-STORY-9: story de outra empresa é 404 e permanece intacta', async () => {
  const [row] = await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,match_type,dm_message,is_active,mode) VALUES (${h.B.id},'QA',ARRAY['CADERNO'],'contains','Texto',true,'send') RETURNING id`
  plan([{ type: 'desativar_regra_story', regra: `#${row.id}` }])
  assert.equal((await h.post(`Desative a regra de story #${row.id}`)).status, 404)
  assert.equal((await h.sql`SELECT is_active FROM instagram_story_automations WHERE id=${row.id}`)[0].is_active, true)
})

test('F3-STORY-10: confirmação story exige admin da empresa e não aceita campos de tenant', async () => {
  plan([story('envio')]); const r = await h.post('Crie regra de story em envio palavra CADERNO mensagem https://example.test/x'); assert.equal(r.body.job.status, 'concluido'); const [row] = await h.sql`SELECT id FROM instagram_story_automations`
  plan([{ type: 'ativar_regra_story', regra: `#${row.id}`, modo: 'envio' }]); const pending = await h.post(`Ative a regra de story #${row.id} em envio`); const id = pending.body.job.id; const before = await view(id)
  h.state.company = h.B; h.state.role = 'platform_admin'
  assert.equal((await confirm(id, 'CADERNO', before)).status, 404)
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_automations`)[0].n, 1)
})

test('F3-STORY-11: ciclo real inactive -> observe prova que o processador nunca envia', async () => {
  const [lead] = await h.sql`SELECT id FROM recovery_leads WHERE company_id=${h.A.id} ORDER BY id LIMIT 1`
  plan([story('nao')]); const created = await h.post('Crie regra de story palavra CADERNO mensagem https://example.test/x')
  assert.equal(created.body.job.status, 'concluido', JSON.stringify(created.body))
  const { handleInstagramStoryReplyItem } = await import('../src/lib/instagram-story-trigger')
  const sent: string[] = []
  const fetchMock = mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => { sent.push(String(url)); return Response.json({ ok: true, message_id: 'x' }) })
  const item = { companyId: h.A.id, companySlug: 'outra-empresa', senderId: 'sender-f3', instagramAccountId: 'ig', lead: { id: lead.id }, itemTimestamp: Date.now(), message: { mid: 'm-f3-1', text: 'CADERNO', reply_to: { story: { id: 'story-f3' } } } }
  try { await handleInstagramStoryReplyItem(item) } finally { fetchMock.mock.restore() }
  assert.equal(sent.length, 0)
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_deliveries WHERE sender_id='sender-f3' AND status IN ('reserved','sent')`)[0].n, 0)
})

test('F3-STORY-12: ativação por cartão troca observe por send e o processador envia uma DM única', async () => {
  const [lead] = await h.sql`SELECT id FROM recovery_leads WHERE company_id=${h.A.id} ORDER BY id LIMIT 1`
  await h.sql`UPDATE recovery_leads SET bot_paused=false, bot_paused_all=false, bot_paused_channel=NULL, bot_paused_by=NULL WHERE id=${lead.id} AND company_id=${h.A.id}`
  await h.sql`UPDATE company_pause_switches SET active=false WHERE company_id=${h.A.id}`
  await h.sql`UPDATE settings SET instagram_access_token='qa-token', instagram_account_id='qa-account' WHERE company_id=${h.A.id}`
  plan([story('nao')]); await h.post('Crie regra de story palavra CADERNO mensagem https://example.test/x')
  const [rule] = await h.sql`SELECT id FROM instagram_story_automations`
  plan([{ type: 'ativar_regra_story', regra: `#${rule.id}`, modo: 'teste' }])
  assert.equal((await h.post(`Ative a regra de story #${rule.id} em teste`)).body.job.status, 'concluido')
  const { handleInstagramStoryReplyItem } = await import('../src/lib/instagram-story-trigger')
  const item = { companyId: h.A.id, companySlug: 'outra-empresa', senderId: 'sender-f3', instagramAccountId: 'ig', lead: { id: lead.id }, itemTimestamp: Date.now(), message: { mid: 'm-f3-observe', text: 'CADERNO', reply_to: { story: { id: 'story-f3' } } } }
  await handleInstagramStoryReplyItem(item)
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_deliveries WHERE sender_id='sender-f3' AND status='observed'`)[0].n, 1)
  plan([{ type: 'ativar_regra_story', regra: `#${rule.id}`, modo: 'envio' }])
  const card = await h.post(`Ative a regra de story #${rule.id} em envio`); assert.equal(card.body.job.waitingReason, 'confirmacao', JSON.stringify(card.body))
  assert.equal((await confirm(card.body.job.id)).status, 200)
  assert.equal((await h.sql`SELECT is_active,mode,enabled_at FROM instagram_story_automations WHERE id=${rule.id}`)[0].mode, 'send')
  const calls: string[] = []; const fetchMock = mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => { calls.push(String(url)); return Response.json({ ok: true, message_id: 'wamid-f3' }) })
  try {
    await handleInstagramStoryReplyItem({ ...item, itemTimestamp: Date.now(), message: { ...item.message, mid: 'm-f3-2' } })
    await handleInstagramStoryReplyItem({ ...item, itemTimestamp: Date.now(), message: { ...item.message, mid: 'm-f3-2' } })
  } finally { fetchMock.mock.restore() }
  assert.equal(calls.length, 1)
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_deliveries WHERE sender_id='sender-f3' AND status='sent'`)[0].n, 1)
  assert.equal((await h.sql`SELECT count(*)::int n FROM whatsapp_messages WHERE external_id='wamid-f3'`)[0].n, 1)
})

test('F3-STORY-13: editar regra send muda DM somente após cartão e atualiza enabled_at', async () => {
  const [row] = await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,match_type,dm_message,is_active,mode,enabled_at) VALUES (${h.A.id},'QA',ARRAY['CADERNO'],'contains','Anterior',true,'send',now()-interval '1 day') RETURNING id,enabled_at`
  plan([{ type: 'editar_regra_story', regra: `#${row.id}`, novaMensagem: '[LINK_1]' }])
  const pending = await h.post(`Edite a regra de story #${row.id} mensagem https://example.test/novo`)
  assert.equal(pending.body.job.waitingReason, 'confirmacao', JSON.stringify(pending.body))
  const before = row.enabled_at
  assert.equal((await confirm(pending.body.job.id)).status, 200)
  const changed = (await h.sql`SELECT dm_message,is_active,mode,enabled_at FROM instagram_story_automations WHERE id=${row.id}`)[0]
  assert.match(changed.dm_message, /https:\/\/example\.test\/novo/); assert.equal(changed.is_active, true); assert.equal(changed.mode, 'send'); assert.notEqual(String(changed.enabled_at), String(before))
})

test('F3-STORY-14: desfazer criação inativa remove a regra e desfazer desativação send pede cartão', async () => {
  plan([story('nao')]); const created = await h.post('Crie regra de story palavra CADERNO mensagem https://example.test/x'); const [createdRow] = await h.sql`SELECT id FROM instagram_story_automations`
  const [createdAction] = await h.execute.acoesDoJob(h.A.id, created.body.job.id)
  assert.equal((await h.call('undo', createdAction.id)).status, 202)
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_automations WHERE id=${createdRow.id}`)[0].n, 0)
  const [active] = await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,match_type,dm_message,is_active,mode,enabled_at) VALUES (${h.A.id},'QA',ARRAY['ATIVO'],'contains','Texto',true,'send',now()) RETURNING id`
  plan([{ type: 'desativar_regra_story', regra: `#${active.id}` }]); const off = await h.post(`Desative a regra de story #${active.id}`); const [offAction] = await h.execute.acoesDoJob(h.A.id, off.body.job.id)
  assert.equal((await h.call('undo', offAction.id)).status, 202)
  const undoView = await view((await h.sql`SELECT id FROM sac_operator_jobs WHERE idempotency_key=${'undo:' + offAction.id}`)[0].id)
  assert.equal(undoView.job.waitingReason, 'confirmacao')
})

test('F3-STORY-15: CAS contra alteração no painel recusa confirmação', async () => {
  const [row] = await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,match_type,dm_message,is_active,mode) VALUES (${h.A.id},'QA',ARRAY['CADERNO'],'contains','Texto',true,'send') RETURNING id`
  plan([{ type: 'editar_regra_story', regra: `#${row.id}`, novaMensagem: '[LINK_1]' }]); const pending = await h.post(`Edite a regra de story #${row.id} mensagem https://example.test/novo`); const v = await view(pending.body.job.id)
  await h.sql`UPDATE instagram_story_automations SET dm_message='Painel',updated_at=now() WHERE id=${row.id}`
  assert.equal((await confirm(pending.body.job.id, 'CADERNO', v)).body.job.errorCode, 'CONFLICT')
})

test('F3-STORY-16: duplicata de story usa normalização de caixa e acento', async () => {
  await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,match_type,dm_message,is_active,mode) VALUES (${h.A.id},'QA',ARRAY['CADERNO'],'contains','Texto',false,'observe')`
  plan([story('nao')]); const r = await h.post('Crie regra de story palavra cáderno mensagem https://example.test/x')
  assert.equal(r.body.code, 'RULE_EXISTS')
})

test('F3-STORY-17: criação story funciona para Isabela com o mesmo catálogo', async () => {
  h.state.company = h.I
  plan([story('nao')]); const r = await h.post('Crie regra de story palavra CADERNO mensagem https://example.test/x')
  assert.equal(r.body.job.status, 'concluido', JSON.stringify(r.body)); assert.equal((await h.sql`SELECT company_id FROM instagram_story_automations`)[0].company_id, h.I.id)
})

test('F3-STORY-18: dois pedidos concorrentes não criam duas regras', async () => {
  plan([story('nao')])
  const replies = await Promise.all([h.post('Crie regra de story palavra CADERNO mensagem https://example.test/x'), h.post('Crie regra de story palavra CADERNO mensagem https://example.test/x')])
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_automations`)[0].n, 1)
  assert.equal(replies.filter(r => r.body.job?.status === 'concluido').length, 1, JSON.stringify(replies))
})

test('F3-STORY-19: limite de 1.000 bytes conta emoji por UTF-8', async () => {
  const longLink = `https://example.test/${'😀'.repeat(300)}`
  plan([story('nao')])
  const r = await h.post(`Crie regra de story palavra CADERNO mensagem ${longLink}`)
  assert.equal(r.body.code, 'INVALID_MESSAGE', JSON.stringify(r.body))
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_automations`)[0].n, 0)
})

test('F3-STORY-20: cota diária de dez criações é compartilhada por Instagram e Story', async () => {
  for (let i = 0; i < 10; i++) {
    const jobId = randomUUID()
    await h.sql`INSERT INTO sac_operator_jobs (id,company_id,requested_by_user_id,role,request_text,idempotency_key,status,finished_at) VALUES (${jobId},${h.A.id},${h.state.user},'admin','qa',${randomUUID()},'concluido',now())`
    await h.sql`INSERT INTO sac_operator_actions (id,company_id,job_id,ordinal,action_type,request_json,status,idempotency_key,applied_at) VALUES (${randomUUID()},${h.A.id},${jobId},1,${i % 2 ? 'criar_regra_story' : 'criar_regra_instagram'},'{}','concluido',${randomUUID()},now())`
  }
  plan([story('nao')])
  const r = await h.post('Crie regra de story palavra CADERNO mensagem https://example.test/x')
  assert.equal(r.body.code, 'DAILY_RULE_LIMIT', JSON.stringify(r.body)); assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_story_automations`)[0].n, 0)
})

test('F3-STORY-21: ID inventado pelo modelo não autoriza regra fora do pedido', async () => {
  const [row] = await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message,is_active,mode) VALUES (${h.A.id},'QA',ARRAY['CADERNO'],'Texto',true,'send') RETURNING id`
  plan([{ type: 'desativar_regra_story', regra: `#${row.id}` }])
  const result = await h.post('Desative a regra de story CADERNO')
  assert.equal(result.body.code, 'MARKER_REQUIRED')
  assert.equal((await h.sql`SELECT is_active FROM instagram_story_automations WHERE id=${row.id}`)[0].is_active, true)
})

test('F3-STORY-22: edição valida bytes sem depender da validação de criação', async () => {
  const [row] = await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message,is_active,mode) VALUES (${h.A.id},'QA',ARRAY['CADERNO'],'Texto',false,'observe') RETURNING id`
  plan([{ type: 'editar_regra_story', regra: `#${row.id}`, novaMensagem: '[LINK_1]' }])
  const result = await h.post(`Edite a regra de story #${row.id} mensagem https://example.test/${'😀'.repeat(300)}`)
  assert.equal(result.body.code, 'INVALID_MESSAGE')
  assert.equal((await h.sql`SELECT dm_message FROM instagram_story_automations WHERE id=${row.id}`)[0].dm_message, 'Texto')
})

test('F3-TRAVA: criar e confirmar story preserva bot pausa e todas as filas de envio', async () => {
  const snapshot = async () => { const value = JSON.parse(await h.protectedState()); delete value.rules; return value }
  const before = await snapshot()
  plan([story('envio')]); const created = await h.post('Crie regra de story palavra CADERNO mensagem https://example.test/x')
  assert.equal(created.body.job.status, 'concluido')
  const [row] = await h.sql`SELECT id FROM instagram_story_automations`
  plan([{ type: 'ativar_regra_story', regra: `#${row.id}`, modo: 'envio' }])
  const pending = await h.post(`Ative a regra de story #${row.id} em envio`)
  assert.equal((await confirm(pending.body.job.id)).status, 200)
  assert.deepEqual(await snapshot(), before)
})
