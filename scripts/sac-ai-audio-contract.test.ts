import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test, mock } from 'node:test'

mock.module('@/lib/ai/ai-bridge', { namedExports: {
  gerarResposta: async () => ({ ok: true, resposta: { ok: true, status: 'ok', resposta: 'A pessoa pediu agendamento.', acao_detectada: { tipo: 'book' } } }),
} })

test('análise da IA registra proposta sem executar ação nem conceder consentimento', async () => {
  const { interpretConversation } = await import('../src/lib/ai/conversation-insight')
  const result = await interpretConversation({
    company: { id: 1, slug: 'autonomia', name: 'SAC', agentDisplayName: null, agentDisplayNameManual: false } as never,
    lead: { id: 2, companyId: 1, phone: '5511999000000', name: 'Teste' } as never,
    config: { aiAgentKey: 'autonomia' } as never,
    messages: [{ id: 10, direction: 'inbound', content: 'Quero agendar', messageType: 'text', createdAt: new Date(), sendState: null, externalId: null }],
    source: 'conversation',
  })
  assert.equal(result.state, 'interpreted')
  assert.match(result.proposedAction, /Agendar/)
  assert.match(result.executedAction, /Nenhuma ação executada/)
  assert.match(result.consent, /Não concedido/)
})

test('a UI de áudio exige ação explícita, contexto seguro e fallback de upload sem token no browser', async () => {
  const source = await readFile(new URL('../src/components/inbox/ConversationAiPanel.tsx', import.meta.url), 'utf8')
  assert.match(source, /getUserMedia/)
  assert.match(source, /MediaRecorder/)
  assert.match(source, /isSecureContext/)
  assert.match(source, /type="file"/)
  assert.match(source, /Transcrever e interpretar áudio/)
  assert.doesNotMatch(source, /AI_BRIDGE_TOKEN|HERMES_TRANSCRIBE_TOKEN/)
})

test('a rota de áudio usa o transcritor Hermes e não o transporte de mensagens', async () => {
  const source = await readFile(new URL('../src/app/api/inbox/[leadId]/ai/route.ts', import.meta.url), 'utf8')
  assert.match(source, /transcribeWithHermes/)
  assert.match(source, /sacAudioAssets/)
  assert.match(source, /ai_conversation_interpreted/)
  assert.doesNotMatch(source, /sendOutboundForLead/)
})
