// Teste de integração da rota que o publicador de conteúdo chama depois que
// um post entra no ar. Sobe Postgres descartável real, aplica o schema real e
// troca somente '@/lib/db' pela conexão do teste.
//
// Uso (fora do sandbox):
// node --experimental-test-module-mocks --import tsx --test scripts/instagram-ensure-automation-for-media.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { NextRequest } from 'next/server'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'instagram_ensure_automation_for_media_test'

function dockerAvailable(): boolean {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return result.status === 0
}

async function pickFreePortAsync(): Promise<number> {
  const net = await import('node:net')
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('não deu para alocar porta livre')))
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
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 })
      await probe`select 1`
      await probe.end({ timeout: 1 })
      lastError = null
      break
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  if (lastError) throw new Error(`postgres descartável não respondeu a tempo: ${String(lastError)}`)

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
    throw new Error('Docker não disponível: este teste precisa de Postgres real.')
  }

  const disposable = await startDisposablePostgres()
  applyRealSchema(disposable.url)

  const sql = postgres(disposable.url)
  const testDb = drizzle(sql, { schema })
  const originalMasterKey = process.env.SAC_API_KEY
  process.env.SAC_API_KEY = 'master-key-instagram-ensure-test'

  try {
    const [companyA, companyB] = await testDb
      .insert(schema.companies)
      .values([
        { name: 'Empresa A', slug: 'empresa-a' },
        { name: 'Empresa B', slug: 'empresa-b' },
      ])
      .returning()

    const companyAKey = 'agent-key-company-a'
    await testDb.insert(schema.settings).values([
      { companyId: companyA.id, agentRenatoApiKey: companyAKey },
      { companyId: companyB.id },
    ])

    mock.module('@/lib/db', { namedExports: { db: testDb } })
    mock.module('@/lib/auth', {
      namedExports: {
        getCurrentUser: async () => null,
        getCurrentCompany: async () => null,
      },
    })

    const { POST } = await import('../src/app/api/v1/companies/[idOrSlug]/instagram-automations/ensure-for-media/route')

    function request(slug: string, apiKey: string, body: unknown): NextRequest {
      return new NextRequest(
        `https://sac.test/api/v1/companies/${slug}/instagram-automations/ensure-for-media`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify(body),
        },
      )
    }

    const masterKey = process.env.SAC_API_KEY
    assert.ok(masterKey)

    await test('cria uma automação ativa para a mídia e registra auditoria', async () => {
      const literalDmMessage = '  Aqui está sua trilha!\nAproveite.  '
      const response = await POST(
        request(companyA.slug, masterKey, {
          media_id: 'media-123',
          keyword: 'TRILHA',
          dm_message: literalDmMessage,
          name: 'Entrega da trilha',
          media_url: 'https://instagram.test/p/media-123',
          match_type: 'exact',
        }),
        { params: Promise.resolve({ idOrSlug: companyA.slug }) },
      )
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.created, true)
      assert.deepEqual(body.automation, {
        id: body.automation.id,
        name: 'Entrega da trilha',
        mediaId: 'media-123',
        keywords: 'TRILHA',
        isActive: true,
        companyId: companyA.id,
      })

      const [saved] = await testDb
        .select()
        .from(schema.instagramCommentAutomations)
        .where(
          and(
            eq(schema.instagramCommentAutomations.companyId, companyA.id),
            eq(schema.instagramCommentAutomations.mediaId, 'media-123'),
          ),
        )
      assert.ok(saved)
      assert.equal(saved.dmMessage, literalDmMessage, 'dm_message deve ser persistida literalmente')
      assert.equal(saved.matchType, 'exact')
      assert.equal(saved.isActive, true)

      const [audit] = await testDb
        .select()
        .from(schema.agentActivityLogs)
        .where(
          and(
            eq(schema.agentActivityLogs.companyId, companyA.id),
            eq(schema.agentActivityLogs.action, 'ensure_instagram_automation'),
          ),
        )
      assert.ok(audit)
      assert.equal(audit.entityType, 'instagram_comment_automation')
      assert.equal(audit.entityId, String(saved.id))
    })

    await test('segunda chamada para o mesmo media_id atualiza sem duplicar', async () => {
      await testDb
        .update(schema.instagramCommentAutomations)
        .set({ isActive: false })
        .where(
          and(
            eq(schema.instagramCommentAutomations.companyId, companyA.id),
            eq(schema.instagramCommentAutomations.mediaId, 'media-123'),
          ),
        )

      const updatedMessage = 'Novo texto literal, sem normalização.  '
      const response = await POST(
        request(companyA.slug, masterKey, {
          media_id: 'media-123',
          keyword: 'NOVA TRILHA',
          dm_message: updatedMessage,
        }),
        { params: Promise.resolve({ idOrSlug: companyA.slug }) },
      )
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.equal(body.created, false)
      assert.equal(body.automation.isActive, true)
      assert.equal(body.automation.keywords, 'NOVA TRILHA')

      const rows = await testDb
        .select()
        .from(schema.instagramCommentAutomations)
        .where(
          and(
            eq(schema.instagramCommentAutomations.companyId, companyA.id),
            eq(schema.instagramCommentAutomations.mediaId, 'media-123'),
          ),
        )
      assert.equal(rows.length, 1, 'retry não pode criar automação duplicada')
      assert.equal(rows[0].dmMessage, updatedMessage)
      assert.equal(rows[0].isActive, true)
      assert.equal(rows[0].name, 'Entrega da trilha', 'campo opcional ausente não deve apagar o nome existente')
      assert.equal(rows[0].matchType, 'exact', 'campo opcional ausente não deve alterar o match type existente')
    })

    await test('autenticação inválida é rejeitada com 401', async () => {
      const response = await POST(
        request(companyA.slug, 'invalid-key', {
          media_id: 'media-invalid-auth',
          keyword: 'TRILHA',
          dm_message: 'Não deve salvar',
        }),
        { params: Promise.resolve({ idOrSlug: companyA.slug }) },
      )

      assert.equal(response.status, 401)
      const rows = await testDb
        .select()
        .from(schema.instagramCommentAutomations)
        .where(eq(schema.instagramCommentAutomations.mediaId, 'media-invalid-auth'))
      assert.equal(rows.length, 0)
    })

    await test('idOrSlug isola empresas mesmo com a chave mestra global', async () => {
      const [automationA] = await testDb
        .insert(schema.instagramCommentAutomations)
        .values({
          companyId: companyA.id,
          name: 'Automação privada da empresa A',
          mediaId: 'shared-media-id',
          keywords: 'SEGREDO-A',
          dmMessage: 'Mensagem exclusiva da empresa A',
          isActive: false,
        })
        .returning()

      const response = await POST(
        request(companyB.slug, masterKey, {
          media_id: 'shared-media-id',
          keyword: 'TRILHA-B',
          dm_message: 'Mensagem exclusiva da empresa B',
          name: 'Automação da empresa B',
        }),
        { params: Promise.resolve({ idOrSlug: companyB.slug }) },
      )
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.equal(body.created, true, 'registro da outra empresa não pode ser tratado como existente')
      assert.equal(body.automation.companyId, companyB.id)

      const [unchangedA] = await testDb
        .select()
        .from(schema.instagramCommentAutomations)
        .where(eq(schema.instagramCommentAutomations.id, automationA.id))
      assert.equal(unchangedA.dmMessage, 'Mensagem exclusiva da empresa A')
      assert.equal(unchangedA.keywords, 'SEGREDO-A')
      assert.equal(unchangedA.isActive, false)

      const rows = await testDb
        .select()
        .from(schema.instagramCommentAutomations)
        .where(eq(schema.instagramCommentAutomations.mediaId, 'shared-media-id'))
      assert.equal(rows.length, 2)
      assert.deepEqual(new Set(rows.map(row => row.companyId)), new Set([companyA.id, companyB.id]))

      const crossTenant = await POST(
        request(companyB.slug, companyAKey, {
          media_id: 'shared-media-id',
          keyword: 'INVASÃO',
          dm_message: 'Não pode alterar a empresa B',
        }),
        { params: Promise.resolve({ idOrSlug: companyB.slug }) },
      )
      assert.equal(crossTenant.status, 403, 'chave de empresa não pode operar outro tenant')

      const [unchangedB] = await testDb
        .select()
        .from(schema.instagramCommentAutomations)
        .where(
          and(
            eq(schema.instagramCommentAutomations.companyId, companyB.id),
            eq(schema.instagramCommentAutomations.mediaId, 'shared-media-id'),
          ),
        )
      assert.equal(unchangedB.dmMessage, 'Mensagem exclusiva da empresa B')
      assert.equal(unchangedB.keywords, 'TRILHA-B')
    })
  } finally {
    if (originalMasterKey === undefined) delete process.env.SAC_API_KEY
    else process.env.SAC_API_KEY = originalMasterKey
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: ensure-for-media passou contra Postgres descartável real.')
  })
  .catch(error => {
    console.error('Erro fatal no teste ensure-for-media:', error)
    process.exitCode = 1
  })
