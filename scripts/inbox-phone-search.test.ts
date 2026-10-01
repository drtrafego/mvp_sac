// Teste do fix de normalização de busca por telefone no Inbox
// (src/lib/inbox-channel-filter.ts: normalizePhoneDigits/matchesPhoneSearch,
// usadas em src/app/api/inbox/route.ts e src/components/inbox/ConversationList.tsx).
//
// BUG (achado real, 22/09/2026, investigação Erenita/Cleide Santos, Dr. Lucas):
// o telefone é gravado só em dígitos (ver normalizeDigits em sync-agents.ts),
// mas a busca fazia `phone.toLowerCase().includes(term)` SEM normalizar o
// termo digitado. O lead existia no banco com o telefone exato
// (557581784614), na 3ª posição de recência da empresa (bem dentro do LIMIT
// 200 do /api/inbox), mas sumia da busca assim que a pessoa digitava o
// telefone com qualquer pontuação natural (espaço, parênteses, traço, "+55"
// na frente), porque a substring com pontuação nunca aparece dentro do valor
// gravado só em dígitos.
//
// Este teste sobe um Postgres DESCARTÁVEL de verdade via Docker (mesmo
// padrão de scripts/inbox-channel-filter.reconcile.test.ts), cria a tabela
// mínima, insere o lead real do caso (telefone 557581784614) mais um lead
// "vizinho" de teste negativo, e roda a MESMA função matchesPhoneSearch usada
// em produção (não uma reimplementação) contra os termos que a pessoa
// digitaria de verdade. Também cobre o guard de falso positivo (busca por
// nome, sem dígito nenhum, não pode bater em telefone nenhum via
// ''.includes('')).
//
// Uso: npx tsx scripts/inbox-phone-search.test.ts
//      (ou exporte TEST_DATABASE_URL pra pular o Docker)

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { recoveryLeads } from '../src/lib/db/schema'
import { normalizePhoneDigits, matchesPhoneSearch } from '../src/lib/inbox-channel-filter'
import {
  contactExactKey,
  contactSuffixKey,
  parseContactIdentifier,
  readUniqueLeadLookup,
  rememberPhoneLeadLookup,
  resolvePhoneLeadLookup,
} from '../src/lib/contact-resolution'

let passou = 0
let falhou = 0

async function caso(nome: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    passou++
    console.log(`OK   ${nome}`)
  } catch (err) {
    falhou++
    console.error(`FAIL ${nome}`)
    console.error(err instanceof Error ? err.message : err)
  }
}

// ── 1. Testes puros da função (sem banco) ─────────────────────────────────
// O telefone real do caso Erenita/Cleide Santos (Dr. Lucas, sessão
// 20260918_152527_57ca4a89), gravado EXATAMENTE assim no banco.
const PHONE_GRAVADO = '557581784614'

const TERMOS_QUE_DEVEM_BATER = [
  '557581784614', // dígitos crus, idêntico ao gravado
  '+55 75 8178-4614', // "+55" na frente, espaço, traço
  '(75) 8178-4614', // parênteses e traço, sem código do país
  '75 8178 4614', // só espaços
  '81784614', // últimos 8 dígitos (sem DDI nem DDD), contíguos no gravado
  '  557581784614  ', // espaço nas pontas (trim natural de input)
]

async function testesPuros() {
  for (const termo of TERMOS_QUE_DEVEM_BATER) {
    await caso(`matchesPhoneSearch bate: termo digitado "${termo}" x telefone gravado "${PHONE_GRAVADO}"`, () => {
      assert.equal(
        matchesPhoneSearch(PHONE_GRAVADO, termo),
        true,
        `esperava match entre "${termo}" (normalizado: "${normalizePhoneDigits(termo)}") e "${PHONE_GRAVADO}"`
      )
    })
  }

  await caso('matchesPhoneSearch NÃO bate: dígitos que não são substring do telefone gravado', () => {
    assert.equal(matchesPhoneSearch(PHONE_GRAVADO, '999999999'), false)
  })

  await caso('matchesPhoneSearch NÃO bate: termo sem nenhum dígito (busca por nome) não vira match universal de telefone', () => {
    // Guard crítico: sem ele, normalizePhoneDigits('Cleide') === '' e
    // ''.includes('') === true faria QUALQUER lead bater em "telefone" numa
    // busca por nome.
    assert.equal(matchesPhoneSearch(PHONE_GRAVADO, 'Cleide'), false)
    assert.equal(matchesPhoneSearch(PHONE_GRAVADO, 'Erenita'), false)
    assert.equal(matchesPhoneSearch(PHONE_GRAVADO, ''), false)
    assert.equal(matchesPhoneSearch(PHONE_GRAVADO, '   '), false)
  })

  await caso('matchesPhoneSearch tolera phone nulo/vazio sem lançar', () => {
    assert.equal(matchesPhoneSearch(null, '557581784614'), false)
    assert.equal(matchesPhoneSearch(undefined, '557581784614'), false)
    assert.equal(matchesPhoneSearch('', '557581784614'), false)
  })

  await caso('normalizePhoneDigits remove tudo que não é dígito', () => {
    assert.equal(normalizePhoneDigits('+55 (75) 8178-4614'), '557581784614')
    assert.equal(normalizePhoneDigits(null), '')
    assert.equal(normalizePhoneDigits(undefined), '')
  })

  await caso('resolução segura NÃO escolhe arbitrariamente dois DDDs com os mesmos últimos 9 dígitos', () => {
    const leadMap = new Map<string, number>()
    const ambiguousLeadKeys = new Set<string>()

    rememberPhoneLeadLookup(leadMap, ambiguousLeadKeys, 3, '557581784614', 101)
    rememberPhoneLeadLookup(leadMap, ambiguousLeadKeys, 3, '558581784614', 202)

    assert.equal(resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, 3, '581784614'), undefined)
    assert.equal(resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, 3, '557581784614'), 101)
    assert.equal(resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, 3, '558581784614'), 202)
    assert.equal(ambiguousLeadKeys.has(contactSuffixKey(3, '557581784614')!), true)
  })

  await caso('resolução por sufixo continua funcionando quando o sufixo é único na mesma empresa', () => {
    const leadMap = new Map<string, number>()
    const ambiguousLeadKeys = new Set<string>()

    rememberPhoneLeadLookup(leadMap, ambiguousLeadKeys, 3, '557581784614', 101)
    rememberPhoneLeadLookup(leadMap, ambiguousLeadKeys, 4, '558581784614', 202)

    assert.equal(resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, 3, '581784614'), 101)
    assert.equal(resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, 4, '581784614'), 202)
  })

  await caso('contact numérico grande é tratado como telefone, não como leadId via parseInt', () => {
    const parsed = parseContactIdentifier('557581784614')
    assert.deepEqual(parsed, { kind: 'phone', raw: '557581784614', digits: '557581784614' })
  })

  await caso('leadId só fica explícito com prefixo lead:, número sem prefixo vira telefone e inválidos são rejeitados', () => {
    assert.deepEqual(parseContactIdentifier('482'), { kind: 'phone', raw: '482', digits: '482' })
    assert.deepEqual(parseContactIdentifier('581784614'), { kind: 'phone', raw: '581784614', digits: '581784614' })
    assert.deepEqual(parseContactIdentifier('lead:557581784614'), { kind: 'leadId', leadId: 557581784614 })
    assert.deepEqual(parseContactIdentifier('+55 75 8178-4614'), {
      kind: 'phone',
      raw: '+55 75 8178-4614',
      digits: '557581784614',
    })
    assert.throws(() => parseContactIdentifier('lead:0'), /leadId inválido/)
    assert.throws(() => parseContactIdentifier('lead:-1'), /leadId inválido/)
    assert.throws(() => parseContactIdentifier(''), /Contato é obrigatório/)
    assert.throws(() => parseContactIdentifier('   '), /Contato é obrigatório/)
  })

  await caso('chaves ambíguas não vazam para outra empresa', () => {
    const leadMap = new Map<string, number>()
    const ambiguousLeadKeys = new Set<string>()

    rememberPhoneLeadLookup(leadMap, ambiguousLeadKeys, 3, '557581784614', 101)
    rememberPhoneLeadLookup(leadMap, ambiguousLeadKeys, 3, '558581784614', 202)
    rememberPhoneLeadLookup(leadMap, ambiguousLeadKeys, 4, '557581784614', 303)

    assert.equal(readUniqueLeadLookup(leadMap, ambiguousLeadKeys, contactExactKey(4, '557581784614')), 303)
    assert.equal(resolvePhoneLeadLookup(leadMap, ambiguousLeadKeys, 4, '581784614'), 303)
  })
}

// ── 2. Teste de integração: /api/inbox contra Postgres real ──────────────
async function pickFreePortAsync(): Promise<number> {
  const net = await import('node:net')
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object' && addr) {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('não deu pra alocar porta livre')))
      }
    })
  })
}

const CONTAINER_NAME = 'inbox_phone_search_test'

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return r.status === 0
}

async function startDisposablePostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await pickFreePortAsync()
  console.log(`[setup] subindo postgres:16-alpine descartável na porta ${port} (container ${CONTAINER_NAME})...`)
  execFileSync('docker', [
    'run',
    '--rm',
    '-d',
    '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test',
    '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`,
    'postgres:16-alpine',
  ])

  const url = `postgres://postgres:test@127.0.0.1:${port}/test`

  const deadline = Date.now() + 30_000
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 })
      await probe`select 1`
      await probe.end({ timeout: 1 })
      lastErr = null
      break
    } catch (err) {
      lastErr = err
      await new Promise(r => setTimeout(r, 500))
    }
  }
  if (lastErr) {
    throw new Error(`postgres descartável não respondeu a tempo: ${String(lastErr)}`)
  }

  return {
    url,
    stop: () => {
      console.log('[teardown] derrubando container descartável...')
      spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
    },
  }
}

async function testesComPostgres() {
  let stopContainer: (() => void) | null = null
  let databaseUrl = process.env.TEST_DATABASE_URL

  if (!databaseUrl) {
    if (!dockerAvailable()) {
      console.log('[skip] sem TEST_DATABASE_URL e sem Docker: pulando a parte de integração com Postgres.')
      return
    }
    const disposable = await startDisposablePostgres()
    databaseUrl = disposable.url
    stopContainer = disposable.stop
  } else {
    console.log('[setup] usando TEST_DATABASE_URL fornecido, pulando Docker.')
  }

  const client = postgres(databaseUrl)
  const db = drizzle(client)

  try {
    console.log('[setup] criando tabela mínima recovery_leads (só as colunas que a busca do Inbox usa)...')
    await client`
      CREATE TABLE recovery_leads (
        id serial PRIMARY KEY,
        company_id integer NOT NULL,
        phone text NOT NULL,
        name text
      )
    `

    // O lead real do caso: telefone gravado só em dígitos, exatamente como
    // sync-agents.ts grava (normalizeDigits).
    const [erenitaLead] = await client<{ id: number }[]>`
      INSERT INTO recovery_leads (company_id, phone, name)
      VALUES (3, ${PHONE_GRAVADO}, 'Saudação da secretária do consultório')
      RETURNING id
    `
    // Lead vizinho, com telefone parecido mas diferente, pra provar que a
    // busca não fica frouxa demais (falso positivo) depois da normalização.
    await client`
      INSERT INTO recovery_leads (company_id, phone, name)
      VALUES (3, '557500000000', 'Outro paciente, telefone diferente')
    `

    for (const termo of TERMOS_QUE_DEVEM_BATER) {
      await caso(`integração Postgres: termo digitado "${termo}" acha o lead real (id=${erenitaLead.id}) via matchesPhoneSearch`, async () => {
        const rows = await db.select({ id: recoveryLeads.id, phone: recoveryLeads.phone }).from(recoveryLeads)
        const achou = rows.some(r => r.id === erenitaLead.id && matchesPhoneSearch(r.phone, termo))
        assert.equal(achou, true, `esperava achar o lead ${erenitaLead.id} buscando "${termo}"`)
      })
    }

    await caso('integração Postgres: busca por telefone não traz o lead vizinho (sem falso positivo)', async () => {
      const rows = await db.select({ id: recoveryLeads.id, phone: recoveryLeads.phone }).from(recoveryLeads)
      const vizinhoBateu = rows.some(r => r.id !== erenitaLead.id && matchesPhoneSearch(r.phone, '81784614'))
      assert.equal(vizinhoBateu, false, 'lead vizinho (telefone diferente) não deveria bater na busca do telefone da Erenita/Cleide')
    })
  } finally {
    await client.end({ timeout: 2 })
    if (stopContainer) stopContainer()
  }
}

async function main() {
  await testesPuros()
  await testesComPostgres()

  console.log(`\n${passou} passaram, ${falhou} falharam.`)
  if (falhou > 0) process.exitCode = 1
}

main().catch(err => {
  console.error('Erro fatal no teste de busca por telefone:', err)
  process.exitCode = 1
})
