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
  await h.sql`DELETE FROM instagram_comment_automations WHERE keywords='CADERNO'`
  await h.sql`DELETE FROM instagram_story_automations WHERE name='Operador: CADERNO'`
  await h.sql`UPDATE sac_operator_company_settings SET allowed_actions=allowed_actions || '["criar_regra_instagram","editar_regra_instagram","criar_regra_story","editar_regra_story"]'::jsonb`
})

const pedido = 'Crie regra de comentário palavra "CADERNO" '
type Caminho = 'fila' | 'síncrono'
type Caso = { nome: string; pedido: string; dm: string; esperado?: string; erro?: string }
const recusados: Caso[] = [
  { nome: 'prefixo do formato legado', pedido: 'mensagem Olá, retire seu material hoje.', dm: 'Olá, retire' },
  { nome: 'sufixo do formato legado', pedido: 'mensagem Olá, retire seu material hoje.', dm: 'material hoje.' },
  { nome: 'fragmento do formato legado', pedido: 'mensagem Olá, retire seu material hoje.', dm: 'seu material' },
  { nome: 'substring incidental', erro: 'INVALID_MESSAGE', pedido: 'sem fornecer texto de DM.', dm: 'texto de DM' },
  { nome: 'substring com ponto', erro: 'INVALID_MESSAGE', pedido: 'sem fornecer texto de DM.', dm: 'texto de DM.' },
  { nome: 'instrução incidental', erro: 'INVALID_MESSAGE', pedido: 'cria uma regra sem mensagem', dm: 'cria uma regra' },
  { nome: 'prefixo', pedido: 'mensagem: Olá, retire seu material hoje.', dm: 'Olá, retire' },
  { nome: 'sufixo', pedido: 'mensagem: Olá, retire seu material hoje.', dm: 'material hoje.' },
  { nome: 'fragmento do meio', pedido: 'mensagem: Olá, retire seu material hoje.', dm: 'seu material' },
  { nome: 'aspas parciais', pedido: 'mensagem "Olá, retire seu material hoje."', dm: 'Olá, retire seu material' },
  { nome: 'aspas internas parciais', pedido: 'mensagem “Olá, diga «quero o material» para continuar.”', dm: 'quero o material' },
  { nome: 'aspas escapadas parciais', pedido: String.raw`mensagem "Olá, diga \"quero o material\" para continuar."`, dm: 'quero o material' },
  { nome: 'outro rótulo', erro: 'INVALID_MESSAGE', pedido: 'observação: Olá, retire seu material hoje.', dm: 'Olá, retire seu material hoje.' },
  { nome: 'outro rótulo com aspas', erro: 'INVALID_MESSAGE', pedido: 'nota: "Este texto é uma anotação."', dm: 'Este texto é uma anotação.' },
  { nome: 'rótulo dentro de outro campo', erro: 'INVALID_MESSAGE', pedido: 'observação: mensagem: Olá, retire seu material hoje.', dm: 'Olá, retire seu material hoje.' },
  { nome: 'rótulo homóglifo', erro: 'INVALID_MESSAGE', pedido: 'mеnsagem: Olá, retire seu material hoje.', dm: 'Olá, retire seu material hoje.' },
  { nome: 'rótulo zero-width', erro: 'INVALID_MESSAGE', pedido: 'men\u200bsagem: Olá, retire seu material hoje.', dm: 'Olá, retire seu material hoje.' },
  { nome: 'rótulo sem fronteira', erro: 'INVALID_MESSAGE', pedido: 'antimensagem: Olá, retire seu material hoje.', dm: 'Olá, retire seu material hoje.' },
  { nome: 'rótulo fullwidth', erro: 'INVALID_MESSAGE', pedido: 'ｍｅｎｓａｇｅｍ: Olá, retire seu material hoje.', dm: 'Olá, retire seu material hoje.' },
  { nome: 'DM homóglifa', pedido: 'mensagem: Olá, retire seu material.', dm: 'Olá, rеtire seu material.' },
  { nome: 'DM zero-width inserido', pedido: 'mensagem: Olá, retire seu material.', dm: 'Olá, re\u200btire seu material.' },
  { nome: 'DM zero-width removido', pedido: 'mensagem: Olá, re\u200btire seu material.', dm: 'Olá, retire seu material.' },
  { nome: 'normalização Unicode proibida', pedido: 'mensagem: Olá, ação especial.', dm: 'Olá, ação especial.'.normalize('NFD') },
  { nome: 'espaços internos alterados', pedido: 'mensagem: Olá,  ação especial.', dm: 'Olá, ação especial.' },
  { nome: 'aspas sem fechamento', erro: 'INVALID_MESSAGE', pedido: 'mensagem "Olá, retire seu material.', dm: 'Olá, retire seu material.' },
  { nome: 'aspas incompatíveis', erro: 'INVALID_MESSAGE', pedido: 'mensagem “Olá, retire seu material.»', dm: 'Olá, retire seu material.' },
  { nome: 'primeira linha de bloco incompleto', pedido: 'mensagem:\nOlá!\nRetire seu material.\n\nFim do pedido.', dm: 'Olá!' },
  { nome: 'aspas internas em rótulo', pedido: 'mensagem: Diga "quero" para continuar.', dm: 'quero' },
  { nome: 'literal sem delimitação', pedido: 'responda Olá, retire seu material.', dm: 'Olá, retire seu material.' },
]
const aceitos: Caso[] = [
  { nome: 'rótulo legado sem dois-pontos', pedido: 'mensagem Olá, retire seu material.', dm: 'Olá, retire seu material.' },
  { nome: 'texto misto no formato legado', pedido: 'mensagem Olá, veja https://example.test/material', dm: 'Olá, veja [LINK_1]', esperado: 'Olá, veja https://example.test/material' },
  { nome: 'aspas seguidas de instrução', pedido: 'mensagem "Olá, retire seu material." e deixe inativa', dm: 'Olá, retire seu material.' },
  ...[['retas duplas', '"', '"'], ['retas simples', "'", "'"], ['tipográficas duplas', '“', '”'], ['tipográficas simples', '‘', '’'], ['guillemets', '«', '»']].map(([nome, abre, fecha]) => ({ nome, pedido: `mensagem ${abre}Olá, retire seu material.${fecha}`, dm: 'Olá, retire seu material.' })),
  { nome: 'quebra de linha e emoji', pedido: 'mensagem “Olá!\nSeu material chegou 📚”', dm: 'Olá!\nSeu material chegou 📚' },
  { nome: 'quebras equivalentes', pedido: 'mensagem “Olá!\r\nSeu material chegou 📚”', dm: 'Olá!\r\nSeu material chegou 📚' },
  { nome: 'espaços nas pontas', pedido: 'mensagem “  Olá! Seu material chegou.  ”', dm: '  Olá! Seu material chegou.  ', esperado: '  Olá! Seu material chegou.  ' },
  { nome: 'aspas internas escapadas', pedido: String.raw`mensagem "Olá, diga \"quero\" para continuar."`, dm: 'Olá, diga "quero" para continuar.' },
  { nome: 'aspas internas diferentes', pedido: 'mensagem “Olá, diga «quero» para continuar.”', dm: 'Olá, diga «quero» para continuar.' },
  ...['mensagem', 'texto', 'dm', 'resposta', 'MENSAGEM'].map(rotulo => ({ nome: `rótulo ${rotulo}`, pedido: `${rotulo}: Olá, retire seu material.`, dm: 'Olá, retire seu material.' })),
  { nome: 'rótulo com bloco', pedido: 'mensagem:\nOlá!\nSeu material chegou 📚\n\nFim do pedido.', dm: 'Olá!\nSeu material chegou 📚' },
  { nome: 'rótulo com aspas internas', pedido: 'mensagem: Diga "quero" para continuar.', dm: 'Diga "quero" para continuar.' },
  { nome: 'rótulo com aspas delimitadoras', pedido: 'mensagem: "Olá! Seu material chegou."', dm: 'Olá! Seu material chegou.' },
  { nome: 'marcador do próprio pedido', pedido: 'mensagem "Olá! Seu material chegou."', dm: '[PALAVRA_2]', esperado: 'Olá! Seu material chegou.' },
  { nome: 'marcador com link aninhado', pedido: 'mensagem "Olá, veja https://example.test/material"', dm: '[PALAVRA_2]', esperado: 'Olá, veja https://example.test/material' },
  { nome: 'texto misto com marcador', pedido: 'mensagem: Olá, veja https://example.test/material', dm: 'Olá, veja [LINK_1]', esperado: 'Olá, veja https://example.test/material' },
]

function plano(dm: string, tipo: 'comentario' | 'direct' | 'ambos' | 'story' = 'comentario'): AcoesPlan {
  return { actions: [tipo === 'story'
    ? { type: 'criar_regra_story', palavra: '[PALAVRA_1]', mensagem: dm, correspondencia: 'contem', ativar: 'nao' }
    : { type: 'criar_regra_instagram', gatilho: tipo, palavra: '[PALAVRA_1]', mensagem: dm, correspondencia: 'contem', ativar: false }], response: 'ok' }
}
async function executar(caminho: Caminho, text: string, plan: AcoesPlan, erro?: string) {
  if (caminho === 'fila') {
    await h.submit(h.A, text)
    const c = (await h.take())!
    assert.ok(c)
    const result = await h.callExecutor('complete', c, h.body(c, plan))
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, erro ? { estado: 'recusado', codigo: erro } : { estado: 'aplicado', codigo: 'OK' })
  } else {
    const action = () => h.service.createOperatorService({ planner: { tipo: 'sincrono', adapter: { plan: async () => ({ plan, model: 'stub', usage: { inputTokens: 1, outputTokens: 1 } }) } } }).submit({ companyId: h.A.id, userId: h.state.user, role: 'admin', requestText: text, idempotencyKey: randomUUID() })
    if (erro) await assert.rejects(action, { code: erro })
    else assert.equal((await action()).job.status, 'concluido')
  }
}

for (const caminho of ['fila', 'síncrono'] as const) {
  for (const c of recusados) test(`R4 ${caminho} recusa ${c.nome} sem efeito`, async () => {
    const before = await h.protectedState()
    await executar(caminho, pedido + c.pedido, plano(c.dm), c.erro ?? 'INVALID_PLAN')
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_jobs WHERE status='falhou' AND error_code=${c.erro ?? 'INVALID_PLAN'}`)[0].n, 1)
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions`)[0].n, 0)
    assert.equal(await h.protectedState(), before)
  })
  for (const c of aceitos) test(`R4 ${caminho} aceita ${c.nome} integral`, async () => {
    await executar(caminho, pedido + c.pedido, plano('[DM_1]'))
    const rows = await h.sql`SELECT dm_message FROM instagram_comment_automations WHERE company_id=${h.A.id} AND keywords='CADERNO'`
    assert.equal(rows.length, 1)
    assert.equal(rows[0].dm_message, c.esperado ?? c.dm)
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions WHERE status='concluido'`)[0].n, 1)
  })
  for (const tipo of ['direct', 'ambos', 'story'] as const) test(`R4 ${caminho} guarda também criação ${tipo}`, async () => {
    const before = await h.protectedState()
    await executar(caminho, pedido + 'sem fornecer texto de DM.', plano('texto de DM', tipo), 'INVALID_MESSAGE')
    assert.equal(await h.protectedState(), before)
  })
  for (const tipo of ['instagram', 'story'] as const) test(`R4 ${caminho} guarda também edição ${tipo}`, async () => {
    const [row] = tipo === 'instagram'
      ? await h.sql`INSERT INTO instagram_comment_automations (company_id,name,keywords,dm_message,is_active) VALUES (${h.A.id},'Editar','CADERNO','Texto preservado',false) RETURNING id`
      : await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message) VALUES (${h.A.id},'Operador: CADERNO',ARRAY['CADERNO'],'Texto preservado') RETURNING id`
    const plan: AcoesPlan = { actions: [{ type: tipo === 'instagram' ? 'editar_regra_instagram' : 'editar_regra_story', regra: `#${row.id}`, novaMensagem: 'texto de DM' }], response: 'ok' }
    const before = await h.protectedState()
    await executar(caminho, `Edite regra ${tipo} #${row.id} sem fornecer texto de DM.`, plan, 'INVALID_MESSAGE')
    assert.equal(await h.protectedState(), before)
    const rows = tipo === 'instagram' ? await h.sql`SELECT dm_message FROM instagram_comment_automations WHERE id=${row.id}` : await h.sql`SELECT dm_message FROM instagram_story_automations WHERE id=${row.id}`
    assert.equal(rows[0].dm_message, 'Texto preservado')
  })
  for (const empresa of ['mesma', 'outra'] as const) test(`R4 ${caminho} recusa DM e marcador exclusivos de outro job da ${empresa} empresa`, async () => {
    const company = empresa === 'mesma' ? h.A : h.B
    const other = await h.submit(company, 'Crie palavra "ANTERIOR" mensagem "Texto exclusivo do outro job." extra "Marcador exclusivo."')
    const claim = (await h.take())!
    assert.equal(claim.jobId, other.job.id)
    await h.queue.falhar(h.lease(claim), { epoch: claim.epoch, codigo: 'TOOL_USE_DETECTED' })
    const before = await h.protectedState()
    await executar(caminho, pedido + 'mensagem "Mensagem deste pedido."', plano('Texto exclusivo do outro job.'), 'INVALID_PLAN')
    await executar(caminho, pedido + 'mensagem "Mensagem deste pedido."', plano('[DM_2]'), 'MARKER_UNKNOWN')
    await executar(caminho, pedido + 'mensagem "Mensagem deste pedido."', plano('[DM_1]'))
    assert.equal((await h.sql`SELECT dm_message FROM instagram_comment_automations WHERE company_id=${h.A.id} AND keywords='CADERNO'`)[0].dm_message, 'Mensagem deste pedido.')
    await h.sql`DELETE FROM instagram_comment_automations WHERE company_id=${h.A.id} AND keywords='CADERNO'`
    assert.equal(await h.protectedState(), before)
  })
}

test('R4 delimitadores vazios ou só espaços não autorizam uma DM vazia', async () => {
  const { validarMensagem } = await import('../src/lib/operator/acoes/validate')
  for (const original of ['mensagem: ', 'mensagem ""', 'mensagem “   ”', 'mensagem:\n\n']) {
    for (const dm of ['', '   ', '\r\n']) assert.throws(() => validarMensagem(dm, { original }), { code: 'INVALID_MESSAGE' })
  }
})
