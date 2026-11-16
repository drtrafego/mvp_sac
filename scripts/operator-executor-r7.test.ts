import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
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
  await h.sql`UPDATE sac_operator_company_settings SET allowed_actions=allowed_actions || '["criar_regra_instagram","editar_regra_instagram","ativar_regra_instagram","criar_regra_story","editar_regra_story","ativar_regra_story"]'::jsonb`
})

const marcadoresInternos = ['[LINK_99]', '[PALAVRA_1]', '[CONTATO_1]', '[DM_2]', '[T1]']
const privado = 'Conteúdo indivisível da sentinela R7 📚'
const dm = `  ${privado}: ${marcadoresInternos.join(' e ')}.\r\n**Olá**, ação: agendar chamada hoje amanhã.  `

function exata(value: unknown) {
  assert.equal(typeof value, 'string')
  assert.deepEqual(Buffer.from(value as string, 'utf8'), Buffer.from(dm, 'utf8'), 'A DM deve permanecer idêntica byte a byte')
}

function semDM(value: unknown) {
  const serialized = JSON.stringify(value)
  for (const fragment of [privado, '**Olá**', 'agendar chamada hoje amanhã', '[LINK_99]', '[DM_2]']) {
    assert.ok(!serialized.includes(fragment), `Conteúdo privado não pode chegar ao planejador: ${fragment}`)
  }
}

for (const caminho of ['fila', 'síncrono'] as const) {
  for (const tipo of ['comentario', 'direct', 'ambos', 'story'] as const) {
    for (const editar of [false, true]) {
      test(`R7 ${caminho} ${editar ? 'edição' : 'criação'} ${tipo} preserva marcadores internos na DM, cartão e hash`, async () => {
        let chamadas = 0
        async function enviar(requestText: string, plan: AcoesPlan, temDM: boolean) {
          if (caminho === 'fila') {
            const id = (await h.submit(h.A, requestText)).job.id
            const claim = (await h.take())!
            assert.ok(claim)
            assert.equal(claim.jobId, id)
            semDM(claim)
            if (temDM) {
              assert.match(claim.pedido, /mensagem: \[DM_1\]$/)
              const [row] = await h.sql`SELECT marcadores FROM sac_operator_job_privados WHERE job_id=${id} AND company_id=${h.A.id}`
              exata(row.marcadores['[DM_1]'])
              // Há referências válidas fora da DM e referências inexistentes dentro dela.
              // Nenhuma das duas categorias pode ser interpretada no conteúdo da mensagem.
              assert.equal(row.marcadores['[PALAVRA_1]'], 'CADERNO')
              assert.equal(row.marcadores['[CONTATO_1]'], 'sentinela@example.test')
              assert.ok(row.marcadores['[T1]'])
              assert.equal(row.marcadores['[LINK_99]'], undefined)
              assert.equal(row.marcadores['[DM_2]'], undefined)
            }
            chamadas++
            const result = await h.callExecutor('complete', claim, h.body(claim, plan))
            assert.equal(result.status, 200)
            assert.deepEqual(result.body, { estado: 'aplicado', codigo: 'OK' }, 'Marcadores dentro da DM não podem causar recusa')
            assert.equal((await h.sql`SELECT count(*)::int n FROM sac_operator_job_privados WHERE job_id=${id}`)[0].n, 0)
            return id
          }
          const result = await h.service.createOperatorService({ planner: { tipo: 'sincrono', adapter: { plan: async (pedido, contexto) => {
            chamadas++
            semDM([pedido, contexto])
            if (temDM) assert.match(pedido, /mensagem: \[DM_1\]$/)
            return { plan, model: 'stub', usage: { inputTokens: 1, outputTokens: 1 } }
          } } } }).submit({ companyId: h.A.id, userId: h.state.user, role: 'admin', requestText, idempotencyKey: randomUUID() })
          assert.ok(['concluido', 'aguardando_confirmacao'].includes(result.job.status))
          return result.job.id
        }

        let ruleId: number | undefined
        if (editar) {
          const [row] = tipo === 'story'
            ? await h.sql`INSERT INTO instagram_story_automations (company_id,name,keywords,dm_message,is_active,mode) VALUES (${h.A.id},'Operador: CADERNO',ARRAY['CADERNO'],'Texto anterior',true,'send') RETURNING id`
            : await h.sql`INSERT INTO instagram_comment_automations (company_id,name,keywords,dm_message,is_active,trigger_type) VALUES (${h.A.id},'Operador: CADERNO','CADERNO','Texto anterior',true,${tipo === 'comentario' ? 'comment' : tipo === 'ambos' ? 'both' : 'direct'}) RETURNING id`
          ruleId = row.id
        }
        const requestText = `${editar ? `Edite regra ${tipo} #${ruleId}` : `Crie regra ${tipo}`} palavra "CADERNO" contato sentinela@example.test lead REFERENCIA_EXTERNA\nmensagem: «${dm}»`
        const plan: AcoesPlan = { actions: [editar
          ? { type: tipo === 'story' ? 'editar_regra_story' : 'editar_regra_instagram', regra: `#${ruleId}`, novaMensagem: '[DM_1]' }
          : tipo === 'story'
            ? { type: 'criar_regra_story', palavra: '[PALAVRA_1]', mensagem: '[DM_1]', correspondencia: 'contem', ativar: 'nao' }
            : { type: 'criar_regra_instagram', gatilho: tipo, palavra: '[PALAVRA_1]', mensagem: '[DM_1]', correspondencia: 'contem', ativar: true }], response: 'ok' }
        const { planHash } = await import('../src/lib/operator/acoes/canonical')
        async function conferirPreparacao(id: string) {
          const actions = await h.execute.acoesDoJob(h.A.id, id)
          assert.equal(actions.length, 1, 'O conteúdo da DM não pode executar ações adicionais')
          const action = actions[0]
          exata(action.requestJson.regra?.dm_message)
          if (action.actionType.startsWith('editar_')) exata(action.requestJson.novaMensagem)
          const response = await h.call('acoes', id)
          assert.equal(response.status, 200)
          const view = response.body
          assert.equal(planHash(actions), view.job.planHash)
          // Calcula também o hash com a DM esperada, independente do valor preparado.
          const expected = structuredClone(actions)
          expected[0].requestJson.regra!.dm_message = dm
          if (action.actionType.startsWith('editar_')) expected[0].requestJson.novaMensagem = dm
          assert.equal(planHash(expected), view.job.planHash)
          for (const token of [...marcadoresInternos, '  ']) {
            const altered = structuredClone(expected)
            const changed = dm.replace(token, 'SUBSTITUÍDO')
            altered[0].requestJson.regra!.dm_message = changed
            if (action.actionType.startsWith('editar_')) altered[0].requestJson.novaMensagem = changed
            assert.notEqual(planHash(altered), view.job.planHash, `O hash deve cobrir literalmente ${token}`)
          }
          return view
        }
        const regras = () => tipo === 'story'
          ? h.sql`SELECT id,dm_message FROM instagram_story_automations WHERE company_id=${h.A.id} AND name='Operador: CADERNO'`
          : h.sql`SELECT id,dm_message FROM instagram_comment_automations WHERE company_id=${h.A.id} AND keywords='CADERNO'`
        let id = await enviar(requestText, plan, true)
        let view = await conferirPreparacao(id)
        if (tipo === 'story' && !editar) {
          // Story sempre nasce inativo. O cartão real surge na ativação posterior.
          assert.equal(view.job.status, 'concluido')
          const rows = await regras()
          assert.equal(rows.length, 1)
          exata(rows[0].dm_message)
          id = await enviar(`Ative regra de story #${rows[0].id} em envio`, {
            actions: [{ type: 'ativar_regra_story', regra: `#${rows[0].id}`, modo: 'envio' }], response: 'ok',
          }, false)
          view = await conferirPreparacao(id)
        } else {
          const rows = await regras()
          assert.equal(rows.length, editar ? 1 : 0, 'A regra espera confirmação')
          if (editar) assert.equal(rows[0].dm_message, 'Texto anterior')
        }
        assert.equal(view.job.status, 'aguardando_confirmacao')
        assert.equal(view.job.waitingReason, 'confirmacao')
        assert.equal(view.acoes.length, 1)
        exata(view.acoes[0].cartao.mensagem)
        const confirmed = await h.call('confirm', id, { planHash: view.job.planHash, codigo: view.acoes[0].cartao.codigo })
        assert.equal(confirmed.status, 200)
        assert.equal(confirmed.body.job.status, 'concluido')
        const rows = await regras()
        assert.equal(rows.length, 1)
        exata(rows[0].dm_message)
        assert.equal(chamadas, tipo === 'story' && !editar ? 2 : 1)
        assert.equal(h.externalCalls.length, 0)
      })
    }
  }
}
