import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import type { Ator, PreparedAction } from '../src/lib/operator/acoes/types'

// Isola a validação inicial: completarRegra também valida os bytes. Sem essa
// separação, a segunda guarda esconderia uma regressão em prepararPlano.
mock.module('@/lib/db', { namedExports: { db: {} } })
let completed = 0
mock.module('../src/lib/operator/acoes/resolve-rule', { namedExports: {
  acaoDeRegra: () => true,
  completarRegra: async (_ator: Ator, action: PreparedAction) => { completed++; return action },
} })

for (const [label, unit] of [['ASCII', 'a'], ['acentos', 'á'], ['emoji', '😀'], ['acentos e emoji', 'á😀']]) {
  test(`F3-R2-Q22 prepare: fronteira de 1.000/1.001 bytes em ${label}`, async () => {
    const { prepararPlano } = await import('../src/lib/operator/acoes/prepare')
    const body = unit.repeat(Math.floor(1000 / Buffer.byteLength(unit)))
    const message = body + 'x'.repeat(1000 - Buffer.byteLength(body))
    const ator: Ator = { companyId: 1, userId: 'qa', actorName: 'Admin de teste', role: 'admin', companySlug: 'qa' }
    const prepare = (text: string) => prepararPlano(ator, randomUUID(), {
      actions: [{ type: 'criar_regra_story', palavra: '[PALAVRA_1]', mensagem: '[DM_1]', correspondencia: 'contem', ativar: 'nao' }], response: 'ok',
    }, new Map([['[PALAVRA_1]', 'CADERNO'], ['[DM_1]', text]]), `mensagem: "${text}"`,
    { allowedActions: ['criar_regra_story'], maxJobsPerDay: 1000, dailyTokenBudget: 1000000, linkDomains: [] })
    assert.equal(Buffer.byteLength(message), 1000)
    assert.equal(Buffer.byteLength(message + 'x'), 1001)
    const before = completed
    const [accepted] = await prepare(message)
    assert.equal(accepted.requestJson.regra?.dm_message, message)
    assert.equal(completed, before + 1, '1.000 bytes chegam à próxima etapa')
    await assert.rejects(prepare(message + 'x'), { status: 400, code: 'INVALID_MESSAGE' })
    assert.equal(completed, before + 1, '1.001 bytes são barrados antes da guarda redundante')
  })
}
