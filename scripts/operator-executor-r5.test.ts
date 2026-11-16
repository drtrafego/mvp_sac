import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, after, beforeEach, test } from 'node:test'
import type { AcoesPlan } from '../src/lib/operator/acoes/catalog'
import { redactOperatorText } from '../src/lib/operator/privacy'
import { executorHarness, type ExecutorHarness } from './operator-executor-harness'

let h: ExecutorHarness
before(async () => { h = await executorHarness() })
after(async () => { if (h) await h.close() })
beforeEach(async () => {
  await h.reset()
  // Cada caso usa um executor distinto para não consumir a cota de outro caso.
  Object.assign(h.executor, await h.newExecutor())
  await h.sql`DELETE FROM instagram_comment_automations WHERE keywords='CADERNO'`
  await h.sql`DELETE FROM instagram_story_automations WHERE name='Operador: CADERNO'`
  await h.sql`UPDATE sac_operator_company_settings SET allowed_actions=allowed_actions || '["criar_regra_instagram","editar_regra_instagram","criar_regra_story","editar_regra_story"]'::jsonb`
})

type Caminho = 'fila' | 'síncrono'
const recusados: Array<{ nome: string; trecho: string; dm: string; erro?: string }> = [
  { nome: 'rótulo não reconhecido como DM', trecho: 'lembrete: "Conteúdo exclusivo do lembrete."', dm: 'Conteúdo exclusivo do lembrete.' },
  { nome: 'etapa chamada entre aspas', trecho: 'etapa chamada "Qualificados"', dm: 'Qualificados' },
  { nome: 'palavra-gatilho entre aspas', trecho: 'palavra-gatilho "SENHADONOVO"', dm: 'SENHADONOVO' },
  { nome: 'palavra com conectivo', trecho: 'palavra é "SENHADONOVO"', dm: 'SENHADONOVO' },
  { nome: 'marcador de link de entidade', trecho: 'link "https://example.test/material"', dm: '[LINK_1]' },
  { nome: 'marcador de contato de entidade', trecho: 'contato "pessoa@example.test"', dm: '[CONTATO_1]' },
  { nome: 'candidata depois de mensagem explicitamente diferente', erro: 'INVALID_PLAN', trecho: 'mensagem: "Texto autorizado." e "Texto sem autorização."', dm: 'Texto sem autorização.' },
  { nome: 'marcador da palavra não é DM', trecho: 'sem fornecer mensagem.', dm: '[PALAVRA_1]' },
  { nome: 'marcador da etapa não é DM', trecho: 'etapa "Qualificados" sem fornecer mensagem.', dm: '[PALAVRA_2]' },
  { nome: 'marcador de candidata ambígua', trecho: '"Primeira frase." e "Segunda frase."', dm: '[PALAVRA_3]' },

  { nome: 'palavra entre aspas sem mensagem', trecho: 'sem fornecer mensagem.', dm: 'CADERNO' },
  { nome: 'etapa entre aspas', trecho: 'para a etapa "Qualificados" sem fornecer mensagem.', dm: 'Qualificados' },
  { nome: 'produto entre aspas', trecho: 'produto "Curso completo" sem fornecer mensagem.', dm: 'Curso completo' },
  { nome: 'nome entre aspas', trecho: 'nome "Campanha de novembro" sem fornecer mensagem.', dm: 'Campanha de novembro' },
  { nome: 'segunda frase entre aspas', trecho: '"Primeira frase." e "Segunda frase."', dm: 'Segunda frase.' },
  { nome: 'primeira de duas strings ambíguas', trecho: '"Primeira frase." e "Segunda frase."', dm: 'Primeira frase.' },
  { nome: 'observação entre aspas', trecho: 'observação "Somente um lembrete." sem fornecer mensagem.', dm: 'Somente um lembrete.' },
  { nome: 'substring dentro de bloco rotulado', erro: 'INVALID_PLAN', trecho: 'mensagem: "Olá, retire seu material hoje."', dm: 'retire seu material' },
  { nome: 'rótulo alheio sem dois-pontos', trecho: 'nota "Conteúdo exclusivo da nota."', dm: 'Conteúdo exclusivo da nota.' },
  { nome: 'palavra repetida como candidata', trecho: '"CADERNO"', dm: 'CADERNO' },
  { nome: 'etapa repetida como candidata', trecho: 'etapa "Qualificados" e "Qualificados"', dm: 'Qualificados' },
  { nome: 'palavra antes de rótulo explícito', erro: 'INVALID_PLAN', trecho: 'mensagem: "CADERNO"', dm: 'CADERNO' },
  { nome: 'duas candidatas iguais', trecho: '"Olá!" e "Olá!"', dm: 'Olá!' },
]
const aceitos = [
  { nome: 'entidades rotuladas e mensagem na mesma linha', trecho: 'etapa: "Qualificados" produto: "Curso completo" mensagem: "Olá, retire seu material."', dm: 'Olá, retire seu material.' },
  { nome: 'entidade declarada depois da candidata', trecho: 'mensagem: "Olá, retire seu material." etapa "Qualificados"', dm: 'Olá, retire seu material.' },
  { nome: 'link integral rotulado antes de instrução', trecho: 'mensagem "https://example.test/material" e deixe inativa', dm: '[LINK_1]', esperado: 'https://example.test/material' },
  { nome: 'link integral rotulado antes de contato', trecho: 'mensagem "https://example.test/material" para Pessoa Teste 5511988887777', dm: '[LINK_1]', esperado: 'https://example.test/material' },
  { nome: 'única candidata depois da palavra', trecho: 'mensagem: "Olá, retire seu material."', dm: 'Olá, retire seu material.' },
  { nome: 'única candidata depois da etapa', trecho: 'etapa "Qualificados" mensagem: "Olá, retire seu material."', dm: 'Olá, retire seu material.' },
  { nome: 'rótulo explícito com observação', trecho: 'mensagem: "Olá, retire seu material."\nobservação: "Revisar amanhã."', dm: 'Olá, retire seu material.' },
  ...['mensagem', 'texto', 'dm', 'resposta', 'responder', 'enviar', 'mandar', 'envie', 'mande', 'responda'].flatMap(rotulo => ['', ':'].map(doisPontos => ({ nome: `${rotulo}${doisPontos} com aspas`, trecho: `${rotulo}${doisPontos} "Olá, retire seu material."`, dm: 'Olá, retire seu material.' }))),
  { nome: 'parágrafo inteiro', trecho: 'mensagem:\nOlá!\nSeu material chegou 📚\n\nFim.', dm: 'Olá!\nSeu material chegou 📚' },
  { nome: 'CRLF e emoji', trecho: 'mensagem “Olá!\r\nSeu material chegou 📚”', dm: 'Olá!\r\nSeu material chegou 📚' },
  { nome: 'aspas escapadas', trecho: String.raw`mensagem "Olá, diga \"quero\" para continuar."`, dm: 'Olá, diga "quero" para continuar.' },
  { nome: 'marcador próprio', trecho: 'mensagem "Olá, retire seu material."', dm: '[PALAVRA_2]', esperado: 'Olá, retire seu material.' },
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
  for (const tipo of ['comentario', 'direct', 'ambos', 'story'] as const) {
    for (const operacao of ['criação', 'edição'] as const) {
      test(`R5 ${caminho} ${operacao} ${tipo} aceita DM rotulada integral`, async () => {
        const dm = 'Olá, seu material chegou 📚'
        let text = `Crie regra ${tipo} palavra "CADERNO" mensagem: "${dm}"`
        let plan = plano('[DM_1]', tipo)
        if (operacao === 'edição') {
          const [row] = tipo === 'story'
            ? await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message) VALUES (${h.A.id},'Operador: CADERNO',ARRAY['CADERNO'],'Texto anterior') RETURNING id`
            : await h.sql`INSERT INTO instagram_comment_automations (company_id,name,keywords,dm_message,is_active,trigger_type) VALUES (${h.A.id},'Editar','CADERNO','Texto anterior',false,${tipo === 'comentario' ? 'comment' : tipo === 'ambos' ? 'both' : 'direct'}) RETURNING id`
          text = `Edite regra ${tipo} #${row.id} palavra "CADERNO" mensagem: "${dm}"`
          plan = { actions: [{ type: tipo === 'story' ? 'editar_regra_story' : 'editar_regra_instagram', regra: `#${row.id}`, novaMensagem: '[DM_1]' }], response: 'ok' }
        }
        await executar(caminho, text, plan)
        const rows = tipo === 'story'
          ? await h.sql`SELECT dm_message FROM instagram_story_automations WHERE company_id=${h.A.id} AND name='Operador: CADERNO'`
          : await h.sql`SELECT dm_message FROM instagram_comment_automations WHERE company_id=${h.A.id} AND keywords='CADERNO'`
        assert.equal(rows.length, 1)
        assert.equal(rows[0].dm_message, dm)
        assert.equal(h.externalCalls.length, 0)
      })
      for (const c of recusados) test(`R5 ${caminho} ${operacao} ${tipo} recusa ${c.nome}`, async () => {
        let text = `Crie regra ${tipo} palavra "CADERNO" ${c.trecho}`
        let plan = plano(c.dm, tipo)
        if (operacao === 'edição') {
          const [row] = tipo === 'story'
            ? await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message) VALUES (${h.A.id},'Operador: CADERNO',ARRAY['CADERNO'],'Texto preservado') RETURNING id`
            : await h.sql`INSERT INTO instagram_comment_automations (company_id,name,keywords,dm_message,is_active,trigger_type) VALUES (${h.A.id},'Editar','CADERNO','Texto preservado',false,${tipo === 'comentario' ? 'comment' : tipo === 'ambos' ? 'both' : 'direct'}) RETURNING id`
          text = `Edite regra ${tipo} #${row.id} palavra "CADERNO" ${c.trecho}`
          plan = { actions: [{ type: tipo === 'story' ? 'editar_regra_story' : 'editar_regra_instagram', regra: `#${row.id}`, novaMensagem: c.dm }], response: 'ok' }
        }
        const before = await h.protectedState()
        const rulesBefore = JSON.stringify(await h.sql`SELECT id,dm_message,updated_at FROM instagram_story_automations ORDER BY id`)
        await executar(caminho, text, plan, c.erro ?? 'INVALID_MESSAGE')
        assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions`)[0].n, 0)
        assert.equal(await h.protectedState(), before)
        assert.equal(JSON.stringify(await h.sql`SELECT id,dm_message,updated_at FROM instagram_story_automations ORDER BY id`), rulesBefore)
        assert.equal(h.externalCalls.length, 0)
      })
    }
  }
  for (const c of aceitos) test(`R5 ${caminho} aceita ${c.nome}`, async () => {
    await executar(caminho, `Crie regra palavra "CADERNO" ${c.trecho}`, plano('[DM_1]'))
    const rows = await h.sql`SELECT dm_message FROM instagram_comment_automations WHERE company_id=${h.A.id} AND keywords='CADERNO'`
    assert.equal(rows.length, 1)
    assert.equal(rows[0].dm_message, 'esperado' in c ? c.esperado : c.dm)
  })
  for (const tamanho of [1500, 1501]) test(`R5 ${caminho} fronteira de ${tamanho} caracteres`, async () => {
    const dm = 'á'.repeat(tamanho)
    const text = `Crie regra palavra "CADERNO" mensagem: "${dm}"`
    // O schema já recusa literais acima de 1.500. Usa o marcador real para
    // exercitar o limite após a resolução no validador comum aos dois caminhos.
    const marker = [...redactOperatorText(text).markers].find(([, value]) => value === dm)?.[0]
    assert.equal(marker, tamanho > 1500 ? undefined : '[DM_1]')
    await executar(caminho, text, plano('[DM_1]'), tamanho > 1500 ? 'INVALID_MESSAGE' : undefined)
    assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_actions`)[0].n, tamanho > 1500 ? 0 : 1)
  })
}
