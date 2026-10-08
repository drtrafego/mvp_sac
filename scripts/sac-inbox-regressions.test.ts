import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildContextPatch,
  canStartComposerIntent,
  contextFromLead,
  draftAfterAccepted,
  fillReplyTemplate,
  mergeContextDraft,
  unresolvedReplyVariables,
  upsertInboxMessages,
} from '../src/components/inbox/sac-inbox-state'

test('saved SAC context reloads with its pipeline and scheduled return', () => {
  const context = contextFromLead({
    requestSummary: 'Remarcar a reserva', commitment: 'Retornar às 16h', nextAction: 'Consultar recepção',
    nextActionDueAt: '2026-10-09T15:00:00.000Z', pipelineStage: 'proposta_enviada',
    followUpDate: '2026-10-10T15:00:00.000Z', followUpNote: 'Confirmar disponibilidade', sacCaseState: 'aguardando_retorno',
  })
  assert.equal(context.requestSummary, 'Remarcar a reserva')
  assert.equal(context.pipelineStage, 'proposta_enviada')
  assert.equal(context.followUpDate, '2026-10-10')
  assert.equal(context.sacCaseState, 'aguardando_retorno')
})

test('an inferred sale stays won when no explicit pipeline stage exists', () => {
  assert.equal(contextFromLead({ eventType: 'compra_aprovada', pipelineStage: null }).pipelineStage, 'fechado')
})

test('a scheduled lead inferred from priority keeps its existing pipeline stage', () => {
  assert.equal(contextFromLead({ priority: 2, pipelineStage: null }).pipelineStage, 'agendado')
})

test('editing only requestSummary never clears the pipeline or return', () => {
  const draft = contextFromLead({ requestSummary: 'Nova solicitação', pipelineStage: 'fechado', followUpDate: '2026-10-10T15:00:00Z' })
  assert.deepEqual(buildContextPatch(draft, new Set(['requestSummary']), 7), { expectedContextVersion: 7, requestSummary: 'Nova solicitação' })
})

test('polling preserves dirty fields while refreshing other context', () => {
  const editing = contextFromLead({ requestSummary: 'Edição em andamento', commitment: 'Antigo', followUpNote: 'Minha nota' })
  const incoming = contextFromLead({ requestSummary: 'Servidor', commitment: 'Novo acordo', followUpNote: 'Outra nota' })
  const result = mergeContextDraft(editing, incoming, new Set(['requestSummary', 'followUpNote']))
  assert.equal(result.requestSummary, 'Edição em andamento')
  assert.equal(result.followUpNote, 'Minha nota')
  assert.equal(result.commitment, 'Novo acordo')
})

test('support closure does not write sales stage or bot pause', () => {
  const draft = contextFromLead({ sacCaseState: 'resolvido', pipelineStage: 'qualificado' })
  assert.deepEqual(buildContextPatch(draft, new Set(['sacCaseState']), 4), { expectedContextVersion: 4, sacCaseState: 'resolvido' })
})

test('calendar return writes a local midday date and supports explicit removal', () => {
  const draft = contextFromLead({ followUpDate: '2026-10-10T15:00:00Z' })
  assert.deepEqual(buildContextPatch(draft, new Set(['followUpDate']), 1), { expectedContextVersion: 1, followUpDate: '2026-10-10T15:00:00.000Z' })
  assert.equal(buildContextPatch({ ...draft, followUpDate: '' }, new Set(['followUpDate']), 2).followUpDate, null)
})

test('templates keep unavailable facts visibly unresolved instead of inventing values', () => {
  const value = fillReplyTemplate('Olá {nome}, seu {produto} chega em {prazo}.', { nome: 'Ana', produto: null })
  assert.equal(value, 'Olá Ana, seu {produto} chega em {prazo}.')
  assert.deepEqual(unresolvedReplyVariables(value), ['produto', 'prazo'])
})

test('explicit variable filling resolves every required value without case sensitivity', () => {
  assert.equal(fillReplyTemplate('{NOME}: {valor}, {prazo}', { nome: 'Ana', valor: 'R$ 50', prazo: 'sexta-feira' }), 'Ana: R$ 50, sexta-feira')
  assert.deepEqual(unresolvedReplyVariables('{nome} {nome} {prazo}'), ['nome', 'prazo'])
})

test('an accepted old send preserves newly typed composer content', () => {
  assert.equal(draftAfterAccepted('Outra mensagem recém-digitada', 'Mensagem enviada'), 'Outra mensagem recém-digitada')
  assert.equal(draftAfterAccepted('  Mensagem enviada  ', 'Mensagem enviada'), '')
})

test('uncertain and processing sends keep their original immutable payload', () => {
  for (const state of ['uncertain', 'pending'] as const) {
    const intent = { clientRequestId: 'request-1', content: 'Primeiro texto', state }
    assert.equal(canStartComposerIntent(intent, 'Primeiro texto'), true)
    assert.equal(canStartComposerIntent(intent, 'Texto modificado'), false)
  }
  assert.equal(canStartComposerIntent({ clientRequestId: 'request-1', content: 'Primeiro texto', state: 'failed' }, 'Texto modificado'), true)
})

test('poll and send responses update one real message instead of adding duplicates', () => {
  const old = { id: 10, content: 'Texto', sendState: 'pending', createdAt: '2026-10-08T10:00:00Z' }
  const updated = { ...old, sendState: 'accepted' }
  const result = upsertInboxMessages([old], [updated])
  assert.equal(result.length, 1)
  assert.equal(result[0].sendState, 'accepted')
})
