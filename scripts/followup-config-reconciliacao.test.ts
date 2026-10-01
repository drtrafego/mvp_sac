import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import Module from 'node:module'
import {
  resolveAgentSlugForCompany,
  validateStepsStrict,
} from '../src/lib/followup'

test('resolveAgentSlugForCompany usa mapa explicito para Amanda e ignora empresas fora do mapa', () => {
  assert.equal(resolveAgentSlugForCompany('amanda'), 'casaldotrafego')
  assert.equal(resolveAgentSlugForCompany('demo-sac'), null)
})

test('validateStepsStrict rejeita item invalido com erro claro', () => {
  assert.throws(
    () => validateStepsStrict([{ delayMinutes: -1 }, { delayMinutes: 30 }]),
    /steps\[0\]\.delayMinutes precisa ser um inteiro positivo/,
  )

  assert.throws(
    () => validateStepsStrict([{ delayMinutes: 30, extra: true }]),
    /steps\[0\] contém campo desconhecido "extra"/,
  )
})

test('validateStepsStrict rejeita mais de 20 itens', () => {
  assert.throws(
    () => validateStepsStrict(Array.from({ length: 21 }, () => ({ delayMinutes: 30 }))),
    /steps deve ter no máximo 20 itens/,
  )
})

let agentsAvailable = true
let sharedMode: 'ok' | 'null' | 'throw' = 'ok'
let queryCalls: Array<{ query: string; params: unknown[] }> = []
let localWriteCount = 0

const fakeDb = {
  insert: () => {
    localWriteCount += 1
    return {
      values: () => ({
        onConflictDoUpdate: async () => undefined,
      }),
    }
  },
  select: () => {
    throw new Error('select local nao esperado neste teste')
  },
}

const moduleWithLoad = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown
}
const originalLoad = moduleWithLoad._load
moduleWithLoad._load = function patchedLoad(
  this: unknown,
  request: string,
  parent: unknown,
  isMain: boolean,
) {
  if (request === 'server-only') return {}
  if (request === '@/lib/db') return { db: fakeDb }
  if (request === '@/lib/db/schema') {
    return {
      followupConfig: { companyId: 'company_id' },
      followupSent: { companyId: 'company_id', sentAt: 'sent_at' },
    }
  }
  if (request === '@/lib/db/agents-db') {
    return {
      getAgentsDb: async () => (agentsAvailable ? {} : null),
      queryAgentsDb: async (query: string, params: unknown[] = []) => {
        queryCalls.push({ query, params })
        if (sharedMode === 'throw') throw new Error('falha simulada no banco compartilhado')
        if (sharedMode === 'null') return null
        return []
      },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

let saveFollowupConfigReal: typeof import('../src/lib/followup-server')['saveFollowupConfigReal']

before(async () => {
  ;({ saveFollowupConfigReal } = await import('../src/lib/followup-server'))
})

function resetMocks() {
  agentsAvailable = true
  sharedMode = 'ok'
  queryCalls = []
  localWriteCount = 0
}

test('saveFollowupConfigReal rejeita steps invalidos sem escrever no banco', async () => {
  resetMocks()

  const res = await saveFollowupConfigReal('autonomia', 1, {
    enabled: true,
    steps: [{ delayMinutes: -1 } as never],
  })

  assert.equal(res.ok, false)
  assert.match(res.message ?? '', /steps\[0\]\.delayMinutes precisa ser um inteiro positivo/)
  assert.equal(queryCalls.length, 0)
  assert.equal(localWriteCount, 0)
})

test('saveFollowupConfigReal rejeita stepsByOrigin.ad com mais de 20 itens', async () => {
  resetMocks()

  const res = await saveFollowupConfigReal('autonomia', 1, {
    enabled: true,
    steps: [{ delayMinutes: 30 }],
    stepsByOrigin: {
      ad: Array.from({ length: 21 }, () => ({ delayMinutes: 30 })),
    },
  })

  assert.equal(res.ok, false)
  assert.match(res.message ?? '', /stepsByOrigin\.ad deve ter no máximo 20 itens/)
  assert.equal(queryCalls.length, 0)
  assert.equal(localWriteCount, 0)
})

test('saveFollowupConfigReal bloqueia enabled=true do Gramado no servidor', async () => {
  resetMocks()

  const res = await saveFollowupConfigReal('gramado-plaza', 4, {
    enabled: true,
    steps: [{ delayMinutes: 10 }],
  })

  assert.equal(res.ok, false)
  assert.equal(
    res.message,
    'Ativar o disparo do Gramado Plazza em produção exige autorização explícita e teste ao vivo do Gastão — ainda não está liberado.',
  )
  assert.equal(queryCalls.length, 0)
  assert.equal(localWriteCount, 0)
})

test('saveFollowupConfigReal propaga falha do banco compartilhado e nao grava copia local', async () => {
  resetMocks()
  sharedMode = 'null'

  const res = await saveFollowupConfigReal('amanda', 2, {
    enabled: true,
    steps: [{ delayMinutes: 30 }],
  })

  assert.equal(res.ok, false)
  assert.equal(res.message, 'Não consegui salvar no banco compartilhado dos agentes — a mudança real não foi aplicada.')
  assert.equal(queryCalls.length, 1)
  assert.equal(localWriteCount, 0)
})

test('saveFollowupConfigReal falha fechado quando getAgentsDb fica indisponivel', async () => {
  resetMocks()
  agentsAvailable = false

  const res = await saveFollowupConfigReal('amanda', 2, {
    enabled: true,
    steps: [{ delayMinutes: 30 }],
  })

  assert.equal(res.ok, false)
  assert.equal(res.message, 'Não consegui salvar no banco compartilhado dos agentes — a mudança real não foi aplicada.')
  assert.equal(queryCalls.length, 0)
  assert.equal(localWriteCount, 0)
})
