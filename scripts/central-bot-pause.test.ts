import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const leadCalls: Array<Record<string, unknown>> = []
const globalCalls: Array<Record<string, unknown>> = []
let leadResult: unknown = { ok: true, detail: 'lead propagado' }
const globalResult: unknown = { ok: true, detail: 'global propagado' }

mock.module('@/lib/gabi-pause-mirror', {
  namedExports: {
    GABI_AGENT_SLUG: 'gramadoplazza',
    GABI_COMPANY_SLUG: 'gramado-plaza',
    isGabiCompany: (slug: string) => slug.trim().toLowerCase() === 'gramado-plaza',
    mirrorGabiLeadPause: async (input: Record<string, unknown>) => {
      leadCalls.push(input)
      if (leadResult instanceof Error) throw leadResult
      return leadResult
    },
    syncGabiGlobalPause: async (company: Record<string, unknown>) => {
      globalCalls.push(company)
      if (globalResult instanceof Error) throw globalResult
      return globalResult
    },
  },
})

async function main() {
  const {
    centralAgentForCompany,
    centralChatId,
    propagateCentralBotPause,
  } = await import('../src/lib/central-bot-pause')

  const gramado = { id: 12, slug: 'gramado-plaza' }

  await test('pausa e retomada de lead usam empresa, telefone e estado explícitos', async () => {
    leadCalls.length = 0
    leadResult = { ok: true, detail: 'lead propagado' }

    assert.equal(centralChatId('+55 (19) 99876-5432'), '5519998765432')
    assert.deepEqual(await propagateCentralBotPause({
      company: gramado,
      phone: '+55 (19) 99876-5432',
      channel: 'whatsapp',
      paused: true,
      by: 'Maria Atendente',
      leadId: 7,
    }), { ok: true, detail: 'lead propagado' })
    assert.equal(leadCalls.at(-1)?.paused, true)

    await propagateCentralBotPause({
      company: gramado,
      phone: '+55 (19) 99876-5432',
      channel: 'whatsapp',
      paused: false,
      by: 'Maria Atendente',
      leadId: 7,
    })
    assert.equal(leadCalls.at(-1)?.paused, false, 'retomada só chega ao central quando explicitamente pedida')
  })

  await test('pausa global usa o agente central mapeado', async () => {
    globalCalls.length = 0
    await propagateCentralBotPause({ company: gramado, paused: true, global: true, by: 'Painel' })
    assert.deepEqual(globalCalls, [gramado])
    assert.equal(centralAgentForCompany(gramado), 'gramadoplazza')
  })

  await test('empresa sem agente central não chama o banco central nem reativa a Isabela', async () => {
    leadCalls.length = 0
    globalCalls.length = 0
    const result = await propagateCentralBotPause({
      company: { id: 2, slug: 'isabela' },
      phone: '5511999999999',
      paused: true,
    })
    assert.deepEqual(result, { ok: true, skipped: 'empresa sem agente central' })
    const resume = await propagateCentralBotPause({
      company: { id: 2, slug: 'isabela' },
      phone: '5511999999999',
      paused: false,
      global: true,
    })
    assert.deepEqual(resume, { ok: true, skipped: 'empresa sem agente central' })
    assert.equal(leadCalls.length, 0)
    assert.equal(globalCalls.length, 0)
  })

  await test('falha do central não lança e devolve aviso para a rota manter o UPDATE local', async () => {
    leadResult = new Error('central indisponível')
    const result = await propagateCentralBotPause({ company: gramado, phone: '5511999999999', paused: true })
    assert.equal(result.ok, false)
    assert.match(result.warning ?? '', /gravada no SAC/)
    leadResult = { ok: true, detail: 'lead propagado' }
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
