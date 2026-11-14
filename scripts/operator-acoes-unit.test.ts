import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { acoesPlanSchema } from '../src/lib/operator/acoes/catalog'
import { redactOperatorText } from '../src/lib/operator/privacy'
import { createOpenRouterAdapter } from '../src/lib/operator/model-adapter'
import { ACOES_SYSTEM_PROMPT } from '../src/lib/operator/acoes/prompt'

mock.module('@/lib/db', { namedExports: { db: {} } })
async function main() {
  const { resolverMarcadores, somenteMarcadores, temMarcador } = await import('../src/lib/operator/acoes/markers')
  const { validarTextoNota } = await import('../src/lib/operator/acoes/validate')
  const { canonicalJson } = await import('../src/lib/operator/acoes/canonical')
  await test('T-TRAVA1-A catálogo fechado rejeita bot, envio e chaves extras', () => {
    for (const type of ['pausar_bot', 'despausar', 'ligar_bot', 'pause_all', 'unpause', 'set_bot_paused', 'enviar_mensagem', 'enviar_dm', 'enviar_whatsapp']) {
      assert.equal(acoesPlanSchema.safeParse({ actions: [{ type }], response: 'ok' }).success, false)
    }
    for (const key of ['botPaused', 'aiEnabled', 'status', 'pauseAll', 'companyId', 'userId', 'role', 'confirm']) {
      assert.equal(acoesPlanSchema.safeParse({ actions: [{ type: 'mover_etapa', lead: '[T1]', etapa: 'agendado', [key]: true }], response: 'ok' }).success, false)
      assert.equal(acoesPlanSchema.safeParse({ actions: [{ type: 'listar_etapas', [key]: true }], response: 'ok' }).success, false)
    }
    assert.equal(acoesPlanSchema.safeParse({ actions: [{ type: 'editar_regra_story', regra: '[T1]' }], response: 'ok' }).success, false)
    assert.equal(acoesPlanSchema.safeParse({ actions: Array(4).fill({ type: 'listar_etapas' }), response: 'ok' }).success, false)
  })
  await test('marcadores desconhecidos falham fechados; alvo literal é descartado', () => {
    const map = new Map([['[T1]', 'Mariana'], ['[CONTATO_1]', '11988887777']])
    assert.equal(resolverMarcadores(somenteMarcadores('inventado [T1]'), map), 'Mariana')
    assert.throws(() => resolverMarcadores('[T99]', map), { code: 'MARKER_UNKNOWN' })
    assert.equal(temMarcador('inventado', ['T', 'CONTATO']), false)
    assert.equal(temMarcador('[LINK_1]', ['T', 'CONTATO']), false)
  })
  await test('nota preserva trecho ditado e identifica reescrita, limites e controles', () => {
    assert.deepEqual(validarTextoNota('pediu retorno amanhã', 'Anote que pediu retorno amanhã'), { texto: 'pediu retorno amanhã', textoReescrito: false })
    assert.equal(validarTextoNota('mudou de ideia', 'Anote retorno').texto, 'Operador SAC: mudou de ideia')
    assert.equal(validarTextoNota('duas\nlinhas', 'duas linhas').texto, 'duas\nlinhas')
    assert.equal(validarTextoNota('tab\tpermitido\r\nnova linha', 'tab permitido nova linha').texto, 'tab permitido\nnova linha')
    for (const text of ['', '  ', 'x\0y', 'x'.repeat(4001)]) assert.throws(() => validarTextoNota(text, text), { code: 'INVALID_NOTE' })
  })
  await test('T-CORPO-1 corpo real do adaptador tem duas mensagens e nenhum dado privado', async () => {
    let body: { messages: Array<{ role: string; content: string }> } | undefined
    const adapter = createOpenRouterAdapter({ apiKey: 'stub', systemPrompt: ACOES_SYSTEM_PROMPT, parsePlan: v => acoesPlanSchema.parse(v), fetcher: async (url, init) => {
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions')
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ actions: [{ type: 'mover_etapa', lead: '[T1] [T2]', etapa: 'chamada' }], response: 'ok' }) } }] })
    } })
    await adapter.plan(redactOperatorText('Mova a Mariana Souza, telefone 11 98888-7777, para chamada e anote que ela pediu retorno amanhã').text, 512)
    assert.equal(body?.messages.length, 2)
    assert.doesNotMatch(JSON.stringify(body), /Mariana|Souza|98888|7777/)
    assert.match(body!.messages[1].content, /\[T/)
    assert.match(body!.messages[1].content, /\[CONTATO_1\]/)
  })
  await test('hash canônico não depende da ordem das chaves', () => {
    assert.equal(canonicalJson({ z: 1, a: { c: 2, b: 3 } }), canonicalJson({ a: { b: 3, c: 2 }, z: 1 }))
  })
}
void main().catch(() => { process.exitCode = 1 })
