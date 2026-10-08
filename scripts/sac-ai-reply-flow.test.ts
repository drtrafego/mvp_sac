import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import type { AiReplyDependencies } from '../src/lib/ai/ai-reply-flow'

mock.module('@/lib/db', { namedExports: { db: {} } })
mock.module('@/lib/ai/ai-bridge', { namedExports: { gerarResposta: async () => ({ ok: false, motivo: 'sem_config' }) } })
mock.module('@/lib/ai/bot-detector', { namedExports: { detectarBotDoOutroLado: () => ({ bot: false, sinais: [], pontos: 0, msgsLead: 1 }) } })
mock.module('@/lib/outbound-send', { namedExports: { sendOutboundForLead: async () => ({ ok: false, status: 502, message: null }) } })
mock.module('@/lib/agenda-autonomia', { namedExports: {
  marcarReuniao: async () => { throw new Error('transporte real proibido no teste') },
  remarcarReuniao: async () => { throw new Error('transporte real proibido no teste') },
  cancelarReuniao: async () => { throw new Error('transporte real proibido no teste') },
  buscarSlots: async () => { throw new Error('transporte real proibido no teste') },
} })
async function main() {
const { generateAndSendAiReply } = await import('../src/lib/ai-reply')
const { executarAcaoDetectada } = await import('../src/lib/ai/agenda-actions')

type Lead = NonNullable<Awaited<ReturnType<AiReplyDependencies['readLead']>>>
type Intent = NonNullable<Awaited<ReturnType<AiReplyDependencies['readIntent']>>>
function fixture() {
  let lead = { id: 20, companyId: 7, phone: '5511999000011', name: 'Teste', botPaused: false, botPausedBy: null, botControlVersion: 1, aiScheduleState: null, channel: 'whatsapp' } as Lead
  let intent: Intent | undefined
  let generateCount = 0
  let actionCount = 0
  let sendCount = 0
  let transportCount = 0
  let releaseCount = 0
  let failNotice = false
  const deps: AiReplyDependencies = {
    acquireLock: async () => true,
    releaseLock: async () => { releaseCount++ },
    readLead: async () => ({ ...lead }),
    readConfig: async () => ({ companyId: 7, aiSystemPrompt: 'gate', aiAgentKey: 'autonomia' }) as Awaited<ReturnType<AiReplyDependencies['readConfig']>>,
    readCompany: async () => ({ id: 7, slug: 'autonomia' }) as Awaited<ReturnType<AiReplyDependencies['readCompany']>>,
    readHistory: async () => [{ id: 100, direction: 'inbound', content: 'Quero marcar', messageType: 'text', sendState: null, externalId: null, createdAt: new Date('2026-10-08T12:00:00Z') }],
    readIntent: async () => intent,
    persistSchedule: async (_lead, state) => { lead = { ...lead, aiScheduleState: state } },
    pauseIfUnchanged: async (_lead, version, reason) => {
      if (lead.botPaused || lead.botControlVersion !== version) return undefined
      lead = { ...lead, botPaused: true, botPausedBy: reason, botControlVersion: version + 1 }
      return { ...lead }
    },
    detectBot: () => ({ bot: false, sinais: [], pontos: 0, msgsLead: 1 }),
    generate: async () => { generateCount++; return { ok: true, resposta: { ok: true, status: 'ok', resposta: 'Confirmado' } } },
    executeAction: async opts => { actionCount++; return { textoVisivel: opts.textoVisivel, novoState: { eventId: 'confirmed-event' } } },
    send: async input => {
      sendCount++
      intent = { id: 300, companyId: 7, leadId: 20, content: input.content, clientRequestId: input.clientRequestId, sendState: 'pending' } as Intent
      const allowed = !input.beforeTransport || await input.beforeTransport()
      if (!allowed) { intent = { ...intent, sendState: 'failed' }; return { ok: false, status: 409, message: intent } }
      transportCount++
      intent = { ...intent, sendState: failNotice ? 'failed' : 'accepted' }
      return { ok: !failNotice, status: failNotice ? 502 : 200, message: intent }
    },
  }
  return { deps, lead: () => lead, intent: () => intent, pause: () => { lead = { ...lead, botPaused: true, botPausedBy: 'Operador', botControlVersion: (lead.botControlVersion ?? 0) + 1 } }, resume: () => { lead = { ...lead, botPaused: false, botPausedBy: null, botControlVersion: (lead.botControlVersion ?? 0) + 1 } }, fail: (value: boolean) => { failNotice = value }, setIntentState: (value: string) => { if (intent) intent = { ...intent, sendState: value } }, counts: () => ({ generateCount, actionCount, sendCount, transportCount, releaseCount }) }
}

test('handler real envia resposta normal e libera lock', async () => {
  const f = fixture()
  await generateAndSendAiReply(20, f.deps)
  assert.equal(f.counts().transportCount, 1)
  assert.equal(f.intent()?.sendState, 'accepted')
  assert.equal(f.counts().releaseCount, 1)
})

test('encerramento próprio pausa e ainda envia a confirmação final', async () => {
  const f = fixture()
  f.deps.generate = async () => ({ ok: true, resposta: { ok: true, status: 'ok', resposta: 'Time vai ajudar', encerrar: { motivo: 'Humano solicitado' } } })
  await generateAndSendAiReply(20, f.deps)
  assert.equal(f.lead().botPaused, true)
  assert.equal(f.lead().botControlVersion, 2)
  assert.equal(f.counts().transportCount, 1)
})

test('pausa humana durante geração descarta ação e envio', async () => {
  const f = fixture()
  let release!: (value: Awaited<ReturnType<AiReplyDependencies['generate']>>) => void
  let started!: () => void
  const generating = new Promise<void>(resolve => { started = resolve })
  const bridge = new Promise<Awaited<ReturnType<AiReplyDependencies['generate']>>>(resolve => { release = resolve })
  f.deps.generate = () => { started(); return bridge }
  const work = generateAndSendAiReply(20, f.deps)
  await generating
  f.pause()
  release({ ok: true, resposta: { ok: true, status: 'ok', resposta: 'Não deve sair', acao_detectada: { tipo: 'book' } } })
  await work
  assert.equal(f.counts().actionCount, 0)
  assert.equal(f.counts().sendCount, 0)
})

test('ação confirmada durante pausa conserva estado e aviso recuperável sem transporte', async () => {
  const f = fixture()
  f.deps.generate = async () => ({ ok: true, resposta: { ok: true, status: 'ok', resposta: 'Agenda confirmada', acao_detectada: { tipo: 'book' } } })
  f.deps.executeAction = async () => { f.pause(); return { textoVisivel: 'Agenda confirmada', novoState: { eventId: 'confirmed-before-pause' } } }
  await generateAndSendAiReply(20, f.deps)
  assert.deepEqual(f.lead().aiScheduleState, { eventId: 'confirmed-before-pause' })
  assert.equal(f.counts().transportCount, 0)
  assert.equal(f.intent()?.content, 'Agenda confirmada')
  assert.equal(f.intent()?.sendState, 'failed')
})

test('aviso falho é reusado sem gerar ou executar novamente a ação', async () => {
  const f = fixture()
  const generate = f.deps.generate
  f.deps.generate = async opts => { const result = await generate(opts); return result.ok ? { ...result, resposta: { ...result.resposta, acao_detectada: { tipo: 'book' } } } : result }
  f.fail(true)
  await generateAndSendAiReply(20, f.deps)
  const key = f.intent()?.clientRequestId
  assert.equal(f.counts().actionCount, 1)
  f.fail(false)
  await generateAndSendAiReply(20, f.deps)
  assert.equal(f.counts().generateCount, 1)
  assert.equal(f.counts().actionCount, 1)
  assert.equal(f.intent()?.clientRequestId, key)
  assert.equal(f.intent()?.sendState, 'accepted')
})

test('aviso aceito não é enviado de novo', async () => {
  const f = fixture()
  await generateAndSendAiReply(20, f.deps)
  await generateAndSendAiReply(20, f.deps)
  assert.equal(f.counts().generateCount, 1)
  assert.equal(f.counts().transportCount, 1)
})

test('pausa humana após encerramento próprio impede o aviso final', async () => {
  const f = fixture()
  f.deps.generate = async () => ({ ok: true, resposta: { ok: true, status: 'ok', resposta: 'Final', encerrar: { motivo: 'Fim' } } })
  const send = f.deps.send
  f.deps.send = async input => { f.pause(); return send(input) }
  await generateAndSendAiReply(20, f.deps)
  assert.equal(f.counts().transportCount, 0)
  assert.equal(f.lead().botPausedBy, 'Operador')
})


for (const state of ['pending', 'uncertain']) {
  test(`aviso ${state} não dispara nova ação nem transporte`, async () => {
    const f = fixture()
    await generateAndSendAiReply(20, f.deps)
    f.setIntentState(state)
    await generateAndSendAiReply(20, f.deps)
    assert.equal(f.counts().generateCount, 1)
    assert.equal(f.counts().transportCount, 1)
  })
}

test('rodada usa a última mensagem recebida mesmo com outbound posterior', async () => {
  const f = fixture()
  const read = f.deps.readHistory
  f.deps.readHistory = async (...args) => [{ id: 101, direction: 'outbound', content: 'Aviso anterior', messageType: 'text', sendState: null, externalId: null, createdAt: new Date('2026-10-08T13:00:00Z') }, ...await read(...args)]
  f.deps.generate = async opts => {
    assert.equal(opts.mensagem, 'Quero marcar')
    return { ok: true, resposta: { ok: true, status: 'ok', resposta: 'Resposta à solicitação' } }
  }
  await generateAndSendAiReply(20, f.deps)
  assert.equal(f.intent()?.clientRequestId, 'ai-reply:7:20:100')
})


test('intentos falhos, pendentes ou incertos não viram falas no histórico nem no detector', async () => {
  const f = fixture()
  const read = f.deps.readHistory
  const old = new Date('2026-10-08T11:00:00Z')
  f.deps.readHistory = async (...args) => [...await read(...args),
    ...['failed', 'pending', 'uncertain'].map((sendState, index) => ({ id: 90 + index, direction: 'outbound', content: 'Nunca enviado', messageType: 'text', sendState, externalId: null, createdAt: old })),
    { id: 80, direction: 'outbound', content: 'Enviado e aceito', messageType: 'text', sendState: 'accepted', externalId: 'provider-id', createdAt: old },
    { id: 70, direction: 'outbound', content: 'Histórico legado comprovado', messageType: 'text', sendState: null, externalId: 'legacy-provider-id', createdAt: old },
  ]
  f.deps.detectBot = lines => { assert.equal(lines.some(line => line.text === 'Nunca enviado'), false); return { bot: false, sinais: [], pontos: 0, msgsLead: 1 } }
  f.deps.generate = async opts => {
    assert.deepEqual(opts.historico.map(turn => turn.text), ['Histórico legado comprovado', 'Enviado e aceito'])
    return { ok: true, resposta: { ok: true, status: 'ok', resposta: 'Resposta' } }
  }
  await generateAndSendAiReply(20, f.deps)
  assert.equal(f.counts().transportCount, 1)
})

test('agenda real revalida pausa depois de buscar slots e antes de marcar', async () => {
  let paused = false
  let booked = 0
  const result = await executarAcaoDetectada({
    acao: { tipo: 'book', nome: 'Teste', email: 'teste@example.com', start: '2030-01-10T15:00:00Z', end: '2030-01-10T15:30:00Z' },
    textoVisivel: 'Marcado', telefone: '5511999000011', nomeContato: 'Teste', state: {},
  }, {
    now: () => new Date('2026-10-08T00:00:00Z'),
    buscarSlotsFn: async () => { paused = true; return { ok: true, horarios: [{ start: '2030-01-10T15:00:00Z', end: '2030-01-10T15:30:00Z' }] } },
    marcarReuniaoFn: async () => { booked++; return { ok: true, event_id: 'bad' } },
    beforeExternalEffect: async () => !paused,
  })
  assert.equal(booked, 0)
  assert.deepEqual(result.novoState, {})
  assert.notEqual(result.textoVisivel, 'Marcado')
})

}
main().catch(error => { console.error(error); process.exitCode = 1 })
