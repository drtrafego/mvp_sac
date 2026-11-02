import assert from 'node:assert/strict'
import { test, mock } from 'node:test'

mock.module('@/lib/db', { namedExports: {
  db: { execute: async () => ({ rows: [{ id: 1 }] }) },
} })

async function main() {
  process.env.AI_BRIDGE_URL = 'http://bridge.test/interno/gerar-resposta'
  process.env.AI_BRIDGE_TOKEN = 'test-token'
  const { gerarResposta } = await import('../src/lib/ai/ai-bridge')

  test('ponte aceita ação conhecida e limita os campos executáveis', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true,
      status: 'ok',
      resposta: 'Vou confirmar o horário.',
      acao_detectada: {
        tipo: 'book',
        nome: 'Teste',
        email: 'teste@example.com',
        start: '2030-01-10T15:00:00Z',
        end: '2030-01-10T15:30:00Z',
        comando_arbitrario: 'não deve atravessar a fronteira',
      },
    }), { status: 200 })
    try {
      const result = await gerarResposta({ bot: 'nina', mensagem: 'teste', historico: [] })
      assert.equal(result.ok, true)
      if (result.ok) {
        assert.deepEqual(result.resposta.acao_detectada, {
          tipo: 'book',
          nome: 'Teste',
          email: 'teste@example.com',
          start: '2030-01-10T15:00:00Z',
          end: '2030-01-10T15:30:00Z',
        })
      }
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('ponte rejeita tipo de ação desconhecido antes do executor', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: true,
      status: 'ok',
      resposta: 'Não deve ser enviado.',
      acao_detectada: { tipo: 'delete_customer_data' },
    }), { status: 200 })
    try {
      const result = await gerarResposta({ bot: 'nina', mensagem: 'teste', historico: [] })
      assert.deepEqual(result, { ok: false, motivo: 'erro' })
    } finally {
      globalThis.fetch = previousFetch
    }
  })
}

main().catch(error => { console.error(error); process.exitCode = 1 })
