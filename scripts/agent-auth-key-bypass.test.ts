// Teste do bypass de autenticação em src/lib/agent-auth.ts (fallback de
// "reconhecimento determinístico por prefixo de chave gerada").
//
// Contexto do bug: authenticateAgentRequest() tinha um fallback que, quando
// nenhuma chave real batia no banco, aceitava QUALQUER string no formato
// sac_<tipo>_<slug>_<qualquercoisa> desde que o slug existisse — sem nunca
// validar o hash (a parte depois do slug) contra o valor real persistido em
// settings.agent*ApiKey / companies.invite_token. Como o slug é informação
// pública (aparece em URLs de webhook tipo /api/webhooks/hermes/[slug]/...),
// isso dava acesso admin total a qualquer empresa cujo slug alguém adivinhasse.
//
// Mesmo padrão de scripts/hermes-conversion-webhook.test.ts: sobe um
// Postgres DESCARTÁVEL real via Docker, aplica o schema real via
// drizzle-kit push, mocka só '@/lib/db' pra apontar pro Postgres descartável,
// e chama authenticateAgentRequest() de verdade com um NextRequest de verdade.
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/agent-auth-key-bypass.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import crypto from 'node:crypto'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { NextRequest as RealNextRequest } from 'next/server'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'agent_auth_bypass_test'

function dockerAvailable(): boolean {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return r.status === 0
}

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

async function startDisposablePostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await pickFreePortAsync()
  console.log(`[setup] subindo postgres:16-alpine descartável na porta ${port} (container ${CONTAINER_NAME})...`)
  execFileSync('docker', [
    'run', '--rm', '-d',
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
  if (lastErr) throw new Error(`postgres descartável não respondeu a tempo: ${String(lastErr)}`)

  return {
    url,
    stop: () => {
      console.log('[teardown] derrubando container descartável...')
      spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
    },
  }
}

function applyRealSchema(databaseUrl: string) {
  console.log('[setup] aplicando o schema real do projeto via drizzle-kit push...')
  execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  })
}

async function main() {
  if (!dockerAvailable()) {
    console.error('Docker não disponível: este teste precisa de um Postgres descartável real.')
    process.exitCode = 1
    return
  }

  const disposable = await startDisposablePostgres()
  applyRealSchema(disposable.url)

  const sql = postgres(disposable.url)
  const testDb = drizzle(sql, { schema })

  // Empresa "de verdade" (cliente real pagante nesta metáfora): slug
  // previsível, como os slugs reais (gramado-plaza, drlucas, autonomia).
  const [company] = await testDb
    .insert(schema.companies)
    .values({ name: 'Gramado Plaza (teste)', slug: 'gramado-plaza-teste' })
    .returning()

  // Chave real, determinística, no MESMO formato que o self-healing schema
  // gera em produção (src/lib/db/index.ts): sac_<agente>_<slug>_<md5(id_agente)>
  const realBiaKey = `sac_bia_${company.slug}_${crypto.createHash('md5').update(`${company.id}_bia`).digest('hex')}`
  const realInviteToken = `sac_company_${company.slug}_${crypto.createHash('md5').update(`${company.id}_token`).digest('hex')}`
  const realPublicadorKey = `sac_publicador_${company.slug}_${crypto.randomBytes(24).toString('hex')}`

  await testDb.insert(schema.settings).values({
    companyId: company.id,
    agentBiaApiKey: realBiaKey,
    agentPublicadorApiKey: realPublicadorKey,
  })
  await testDb.update(schema.companies).set({ inviteToken: realInviteToken }).where(eq(schema.companies.id, company.id))

  mock.module('@/lib/db', {
    namedExports: { db: testDb },
  })
  // authenticateAgentRequest cai no caminho de sessão de navegador quando
  // não há API key; não é exercitado aqui (todo teste manda API key), mas
  // precisa existir pro import não quebrar.
  mock.module('@/lib/auth', {
    namedExports: {
      getCurrentUser: async () => null,
      getCurrentCompany: async () => null,
    },
  })

  const { authenticateAgentRequest } = await import('../src/lib/agent-auth')

  function makeRequest(apiKey: string): InstanceType<typeof RealNextRequest> {
    return new RealNextRequest('https://sac.casaldotrafego.com/api/v1/companies/gramado-plaza-teste/settings', {
      method: 'GET',
      headers: { 'x-api-key': apiKey },
    })
  }

  try {
    // ── EXPLOIT: chave FORJADA (prefixo certo, slug real, sufixo arbitrário) ──
    // Isto é exatamente o que o achado descreve: qualquer atacante que saiba
    // (ou adivinhe) o slug consegue montar esta string sem nunca ter visto a
    // chave real.
    await test('EXPLOIT: chave forjada sac_admin_<slug-real>_lixo NÃO deve autenticar como admin', async () => {
      const chaveForjada = `sac_admin_${company.slug}_lixo-qualquer-coisa-aqui`
      const req = makeRequest(chaveForjada)
      const { error, context } = await authenticateAgentRequest(req, company.slug)

      assert.ok(error, 'chave forjada deveria ser REJEITADA (error presente)')
      assert.equal(context, undefined, 'chave forjada NÃO deveria produzir um contexto autenticado')
      if (error) {
        const json = await error.json()
        assert.equal(error.status, 401, `esperava 401, veio ${error.status} (body: ${JSON.stringify(json)})`)
        assert.equal(json.code, 'INVALID_API_KEY')
      }
    })

    await test('EXPLOIT: variação sac_bia_<slug-real>_qualquercoisa (tipo bia) também deve ser rejeitada', async () => {
      const chaveForjada = `sac_bia_${company.slug}_00000000000000000000000000000000`
      const req = makeRequest(chaveForjada)
      const { error, context } = await authenticateAgentRequest(req, company.slug)
      assert.ok(error, 'chave forjada (tipo bia) deveria ser REJEITADA')
      assert.equal(context, undefined)
    })

    // ── controle negativo: chave REAL persistida continua funcionando ──────
    await test('chave REAL (persistida no banco) continua autenticando normalmente', async () => {
      const req = makeRequest(realBiaKey)
      const { error, context } = await authenticateAgentRequest(req, company.slug)
      assert.equal(error, undefined, `chave real não deveria ser rejeitada (error: ${error ? (await error.json()).error : ''})`)
      assert.ok(context)
      if (context) {
        assert.equal(context.company.id, company.id)
        assert.equal(context.isAdmin, true)
        assert.equal(context.agentId, 'bia')
      }
    })

    await test('chave REAL do publicador autentica como publicador, não como admin genérico', async () => {
      const req = makeRequest(realPublicadorKey)
      const { error, context } = await authenticateAgentRequest(req, company.slug)
      assert.equal(error, undefined, `chave publicador real não deveria ser rejeitada (error: ${error ? (await error.json()).error : ''})`)
      assert.ok(context)
      if (context) {
        assert.equal(context.company.id, company.id)
        assert.equal(context.isAdmin, true)
        assert.equal(context.agentId, 'publicador')
      }
    })

    await test('invite_token REAL (persistido no banco) continua autenticando normalmente', async () => {
      const req = makeRequest(realInviteToken)
      const { error, context } = await authenticateAgentRequest(req, company.slug)
      assert.equal(error, undefined, `invite_token real não deveria ser rejeitado (error: ${error ? (await error.json()).error : ''})`)
      assert.ok(context)
      if (context) {
        assert.equal(context.company.id, company.id)
        assert.equal(context.isAdmin, true)
      }
    })

    await test('chave totalmente aleatória (sem relação com nenhuma empresa) é rejeitada', async () => {
      const req = makeRequest('sac_admin_empresa-que-nao-existe_qualquercoisa')
      const { error, context } = await authenticateAgentRequest(req, undefined)
      assert.ok(error)
      assert.equal(context, undefined)
      if (error) assert.equal(error.status, 401)
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: nenhuma chave forjada autenticou, e as chaves reais continuam funcionando.')
  })
  .catch(err => {
    console.error('Erro fatal no teste de bypass de agent-auth:', err)
    process.exitCode = 1
  })
