import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, after, beforeEach, test } from 'node:test'
import type { AcoesPlan } from '../src/lib/operator/acoes/catalog'
import { executorHarness, type ExecutorHarness } from './operator-executor-harness'

let h: ExecutorHarness
before(async () => { h = await executorHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => {
  await h.reset()
  Object.assign(h.executor, await h.newExecutor())
  await h.sql`DELETE FROM instagram_comment_automations WHERE keywords='CADERNO'`
  await h.sql`DELETE FROM instagram_story_automations WHERE name='Operador: CADERNO'`
  await h.sql`UPDATE sac_operator_company_settings SET allowed_actions=allowed_actions || '["criar_regra_instagram","editar_regra_instagram","criar_regra_story","editar_regra_story"]'::jsonb`
})
const casos = [
  { nome: 'QA lead sem rótulo', trecho: 'lead "PROSPECTO_X"', dm: 'PROSPECTO_X', erro: 'INVALID_MESSAGE' },
  { nome: 'QA cliente sem rótulo', trecho: 'cliente "CLIENTE_X"', dm: 'CLIENTE_X', erro: 'INVALID_MESSAGE' },
  { nome: 'QA dois rótulos primeira', trecho: 'mensagem: "DM_A" mensagem: "DM_B"', dm: 'DM_A', erro: 'INVALID_MESSAGE' },
  { nome: 'QA dois rótulos segunda', trecho: 'mensagem: "DM_A" mensagem: "DM_B"', dm: 'DM_B', erro: 'INVALID_MESSAGE' },
  { nome: 'sem rótulo marcador', trecho: 'lead "PROSPECTO_X"', dm: '[DM_1]', erro: 'INVALID_MESSAGE' },
  { nome: 'ambiguidade marcador', trecho: 'mensagem: "DM_A" mensagem: "DM_B"', dm: '[DM_1]', erro: 'INVALID_MESSAGE' },
  { nome: 'palavra', trecho: 'sem mensagem.', dm: 'CADERNO', erro: 'INVALID_MESSAGE' },
  { nome: 'etapa', trecho: 'etapa "Qualificados"', dm: 'Qualificados', erro: 'INVALID_MESSAGE' },
  { nome: 'segunda frase', trecho: '"Primeira frase" e "Segunda frase"', dm: 'Segunda frase', erro: 'INVALID_MESSAGE' },
  { nome: 'literal igual', trecho: 'mensagem: "Olá, retire seu material hoje."', dm: 'Olá, retire seu material hoje.', erro: 'INVALID_PLAN' },
  { nome: 'substring', trecho: 'mensagem: "Olá, retire seu material hoje."', dm: 'retire seu material', erro: 'INVALID_PLAN' },
  { nome: 'prefixo', trecho: 'mensagem: "Olá, retire seu material hoje."', dm: 'Olá, retire', erro: 'INVALID_PLAN' },
  { nome: 'fragmento incidental', trecho: 'sem fornecer texto de DM.', dm: 'texto de DM', erro: 'INVALID_MESSAGE' },
  { nome: 'observação', trecho: 'observação: mensagem: "Texto privado"', dm: '[DM_1]', erro: 'INVALID_MESSAGE' },
  { nome: 'nota', trecho: 'nota: "mensagem: Texto privado"', dm: '[DM_1]', erro: 'INVALID_MESSAGE' },
  { nome: '1501 caracteres', trecho: 'mensagem: "' + 'a'.repeat(1501) + '"', dm: '[DM_1]', erro: 'INVALID_MESSAGE' },
  { nome: 'vazio', trecho: 'mensagem: ""', dm: '[DM_1]', erro: 'INVALID_MESSAGE' },
  { nome: 'só espaços', trecho: 'mensagem: "   "', dm: '[DM_1]', erro: 'INVALID_MESSAGE' },
  { nome: 'aspas desbalanceadas', trecho: 'mensagem: "Texto privado', dm: '[DM_1]', erro: 'INVALID_MESSAGE' },
  { nome: 'marcador alheio', trecho: 'mensagem: "Texto atual"', dm: '[DM_2]', erro: 'MARKER_UNKNOWN' },
  { nome: 'homóglifo no rótulo', trecho: 'mеnsagem: "Texto privado"', dm: '[DM_1]', erro: 'INVALID_MESSAGE' },
  { nome: 'zero-width no rótulo', trecho: 'men\u200bsagem: "Texto privado"', dm: '[DM_1]', erro: 'INVALID_MESSAGE' },
]
const legitimos = [
  { nome: 'explícito', trecho: 'mensagem: "Olá, seu material chegou 📚"', dm: 'Olá, seu material chegou 📚' },
  { nome: 'legado', trecho: 'mensagem Olá, seu material chegou 📚', dm: 'Olá, seu material chegou 📚' },
  { nome: 'CRLF', trecho: 'mensagem: “Olá!\r\nSeu material chegou 📚”', dm: 'Olá!\r\nSeu material chegou 📚' },
  { nome: 'markdown e NFD', trecho: 'mensagem: "**Olá**, ação 📚"'.normalize('NFD'), dm: '**Olá**, ação 📚'.normalize('NFD') },
  { nome: 'aspas escapadas', trecho: String.raw`mensagem: "Diga \"quero\" agora"`, dm: 'Diga "quero" agora' },
  { nome: 'aspas aninhadas', trecho: 'mensagem: “Diga «quero» agora”', dm: 'Diga «quero» agora' },
  { nome: 'bloco', trecho: 'mensagem:\nOlá!\nMaterial 📚\n\nFim.', dm: 'Olá!\nMaterial 📚' },
]
for (const caminho of ['fila', 'síncrono'] as const) for (const tipo of ['comentario', 'direct', 'ambos', 'story'] as const) for (const editar of [false, true]) {
  async function executar(trecho: string, mensagem: string, erro?: string, esperado?: string) {
    let text = `Crie regra ${tipo} palavra "CADERNO" ${trecho}`
    let plan: AcoesPlan = { actions: [tipo === 'story'
      ? { type: 'criar_regra_story', palavra: '[PALAVRA_1]', mensagem, correspondencia: 'contem', ativar: 'nao' }
      : { type: 'criar_regra_instagram', gatilho: tipo, palavra: '[PALAVRA_1]', mensagem, correspondencia: 'contem', ativar: false }], response: 'ok' }
    if (editar) {
      const [row] = tipo === 'story'
        ? await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message) VALUES (${h.A.id},'Operador: CADERNO',ARRAY['CADERNO'],'Texto preservado') RETURNING id`
        : await h.sql`INSERT INTO instagram_comment_automations (company_id,name,keywords,dm_message,is_active,trigger_type) VALUES (${h.A.id},'Editar','CADERNO','Texto preservado',false,${tipo === 'comentario' ? 'comment' : tipo === 'ambos' ? 'both' : 'direct'}) RETURNING id`
      text = `Edite regra ${tipo} #${row.id} palavra "CADERNO" ${trecho}`
      plan = { actions: [{ type: tipo === 'story' ? 'editar_regra_story' : 'editar_regra_instagram', regra: `#${row.id}`, novaMensagem: mensagem }], response: 'ok' }
    }
    const snapshot = async () => JSON.stringify([await h.protectedState(), await h.sql`SELECT * FROM instagram_story_automations ORDER BY id`])
    const before = await snapshot()
    let jobId = ''
    if (caminho === 'fila') {
      const submitted = await h.submit(h.A, text); jobId = submitted.job.id
      const claim = (await h.take())!
      assert.ok(claim)
      if (esperado) { assert.ok(!JSON.stringify(claim).includes(esperado)); assert.match(claim.pedido, /\[DM_1\]/) }
      const result = await h.callExecutor('complete', claim, h.body(claim, plan))
      assert.equal(result.status, 200)
      assert.deepEqual(result.body, erro ? { estado: 'recusado', codigo: erro } : { estado: 'aplicado', codigo: 'OK' })
    } else {
      const action = () => h.service.createOperatorService({ planner: { tipo: 'sincrono', adapter: { plan: async request => {
        if (esperado) { assert.ok(!request.includes(esperado)); assert.match(request, /\[DM_1\]/) }
        return { plan, model: 'stub', usage: { inputTokens: 1, outputTokens: 1 } }
      } } } }).submit({ companyId: h.A.id, userId: h.state.user, role: 'admin', requestText: text, idempotencyKey: randomUUID() })
      if (erro) await assert.rejects(action, { code: erro })
      else assert.equal((await action()).job.status, 'concluido')
    }
    if (erro) {
      assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions`)[0].n, 0)
      assert.equal(await snapshot(), before)
      if (erro === 'INVALID_MESSAGE') {
        const jobs = await h.sql`SELECT result_text FROM sac_operator_jobs WHERE error_code='INVALID_MESSAGE'`
        assert.match(jobs[0].result_text, /Qual é a mensagem que devo enviar\? Escreva assim: mensagem: \.\.\./)
      }
    } else {
      const rows = tipo === 'story'
        ? await h.sql`SELECT dm_message FROM instagram_story_automations WHERE company_id=${h.A.id} AND name='Operador: CADERNO'`
        : await h.sql`SELECT dm_message FROM instagram_comment_automations WHERE company_id=${h.A.id} AND keywords='CADERNO'`
      assert.equal(rows.length, 1); assert.equal(rows[0].dm_message, esperado)
    }
    if (jobId) assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_job_privados WHERE job_id=${jobId}`)[0].n, 0)
    assert.equal(h.externalCalls.length, 0)
  }
  for (const c of casos) test(`R6 ${caminho} ${editar ? 'edição' : 'criação'} ${tipo} recusa ${c.nome}`, async () => executar(c.trecho, c.dm, c.erro))
  for (const c of [...legitimos, { nome: tipo === 'story' ? 'limite de 1000 bytes do story' : 'limite de 1500 caracteres', trecho: 'mensagem: "' + 'a'.repeat(tipo === 'story' ? 1000 : 1500) + '"', dm: 'a'.repeat(tipo === 'story' ? 1000 : 1500) }]) test(`R6 ${caminho} ${editar ? 'edição' : 'criação'} ${tipo} aceita ${c.nome}`, async () => executar(c.trecho, '[DM_1]', undefined, c.dm))
}

for (const caminho of ['fila', 'síncrono'] as const) test(`R6 ${caminho} cartão e hash cobrem DM exata resolvida no servidor`, async () => {
  await h.sql`UPDATE sac_operator_company_settings SET allowed_actions=allowed_actions || '["ativar_regra_instagram"]'::jsonb`
  const dm = '  **Olá**, ação 📚\r\nDiga "quero".  '
  const requestText = `Crie regra palavra "CADERNO" mensagem: «${dm}»`
  const plan: AcoesPlan = { actions: [{ type: 'criar_regra_instagram', gatilho: 'comentario', palavra: '[PALAVRA_1]', mensagem: '[DM_1]', correspondencia: 'contem', ativar: true }], response: 'ok' }
  let id: string
  if (caminho === 'fila') {
    id = (await h.submit(h.A, requestText)).job.id
    const c = (await h.take())!
    assert.ok(!c.pedido.includes(dm))
    const [privados] = await h.sql`SELECT marcadores FROM sac_operator_job_privados WHERE job_id=${id} AND company_id=${h.A.id}`
    assert.equal(privados.marcadores['[DM_1]'], dm)
    assert.deepEqual((await h.callExecutor('complete', c, h.body(c, plan))).body, { estado: 'aplicado', codigo: 'OK' })
  } else {
    id = (await h.service.createOperatorService({ planner: { tipo: 'sincrono', adapter: { plan: async pedido => {
      assert.ok(!pedido.includes(dm)); assert.match(pedido, /\[DM_1\]/)
      return { plan, model: 'stub', usage: { inputTokens: 1, outputTokens: 1 } }
    } } } }).submit({ companyId: h.A.id, userId: h.state.user, role: 'admin', requestText, idempotencyKey: randomUUID() })).job.id
  }
  const view = (await h.call('acoes', id)).body
  assert.equal(view.job.status, 'aguardando_confirmacao')
  assert.equal(view.acoes[0].cartao.mensagem, dm)
  const { acoesDoJob } = await import('../src/lib/operator/acoes/execute')
  const { planHash } = await import('../src/lib/operator/acoes/canonical')
  const actions = await acoesDoJob(h.A.id, id)
  assert.equal(planHash(actions), view.job.planHash)
  const altered = structuredClone(actions)
  altered[0].requestJson.regra!.dm_message = dm.trim()
  assert.notEqual(planHash(altered), view.job.planHash, 'O hash inclui até os espaços originais')
  assert.equal((await h.sql`SELECT count(*)::int n FROM instagram_comment_automations WHERE company_id=${h.A.id} AND keywords='CADERNO'`)[0].n, 0)
  assert.equal(h.externalCalls.length, 0)
})
