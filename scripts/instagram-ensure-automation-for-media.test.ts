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
import { and, count, eq, isNull } from 'drizzle-orm'
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

    await test('os caminhos global e por mídia não usam transaction do driver Neon', async () => {
      const databaseWithThrowingTransaction = testDb as typeof testDb & {
        transaction: () => Promise<never>
      }
      const originalTransaction = databaseWithThrowingTransaction.transaction
      databaseWithThrowingTransaction.transaction = async () => {
        throw new Error('No transactions support in neon-http driver')
      }
      try {
        const legacy = await POST(request(companyA.slug, masterKey, {
          media_id: 'media-sem-transaction', keyword: 'SEM TRANSACAO', dm_message: 'Legado funciona',
        }), { params: Promise.resolve({ idOrSlug: companyA.slug }) })
        const global = await POST(request(companyA.slug, masterKey, {
          all_posts: true, keyword: 'GLOBAL SEM TRANSACAO', dm_message: 'Global funciona',
        }), { params: Promise.resolve({ idOrSlug: companyA.slug }) })
        assert.equal(legacy.status, 200)
        assert.equal(global.status, 200)
      } finally {
        databaseWithThrowingTransaction.transaction = originalTransaction
      }
    })

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
            eq(schema.agentActivityLogs.entityId, String(saved.id)),
          ),
        )
      assert.ok(audit)
      assert.equal(audit.entityType, 'instagram_comment_automation')
      assert.equal(audit.entityId, String(saved.id))
    })

    await test('rejeita dm_message acima de 4000 caracteres com 400', async () => {
      const response = await POST(
        request(companyA.slug, masterKey, {
          media_id: 'media-dm-message-too-long',
          keyword: 'TRILHA',
          dm_message: 'a'.repeat(4001),
        }),
        { params: Promise.resolve({ idOrSlug: companyA.slug }) },
      )
      const body = await response.json()

      assert.equal(response.status, 400)
      assert.equal(body.error, 'dm_message excede o limite de 4000 caracteres')

      const rows = await testDb
        .select()
        .from(schema.instagramCommentAutomations)
        .where(eq(schema.instagramCommentAutomations.mediaId, 'media-dm-message-too-long'))
      assert.equal(rows.length, 0)
    })

    await test('segunda chamada para o mesmo media_id atualiza sem duplicar e preserva uma pausa existente', async () => {
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
      assert.equal(body.automation.isActive, false)
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
      assert.equal(rows[0].isActive, false, 'um sync de mídia não pode reativar uma automação pausada')
      assert.equal(rows[0].name, 'Entrega da trilha', 'campo opcional ausente não deve apagar o nome existente')
      assert.equal(rows[0].matchType, 'exact', 'campo opcional ausente não deve alterar o match type existente')
    })

    await test('semeia comentários já respondidos manualmente sem duplicar nem enviá-los', async () => {
      const manualCommentIds = ['comment-manual-1', 'comment-manual-2', 'comment-manual-3']
      const response = await POST(
        request(companyA.slug, masterKey, {
          media_id: 'media-123',
          keyword: 'NOVA TRILHA',
          dm_message: 'Novo texto literal, sem normalização.  ',
          manual_comment_ids: manualCommentIds,
        }),
        { params: Promise.resolve({ idOrSlug: companyA.slug }) },
      )
      assert.equal(response.status, 200)

      const logs = await testDb
        .select()
        .from(schema.instagramCommentLogs)
        .where(eq(schema.instagramCommentLogs.companyId, companyA.id))
      assert.equal(logs.length, 3)
      assert.deepEqual(new Set(logs.map((log) => log.commentId)), new Set(manualCommentIds))
      assert.ok(logs.every((log) => log.status === 'skipped'))
      assert.ok(logs.every((log) => log.errorMessage === 'Comentário já respondido manualmente antes da ativação da automação.'))

      const retry = await POST(
        request(companyA.slug, masterKey, {
          media_id: 'media-123',
          keyword: 'NOVA TRILHA',
          dm_message: 'Novo texto literal, sem normalização.  ',
          manual_comment_ids: manualCommentIds,
        }),
        { params: Promise.resolve({ idOrSlug: companyA.slug }) },
      )
      assert.equal(retry.status, 200)

      const [logCount] = await testDb
        .select({ value: count() })
        .from(schema.instagramCommentLogs)
        .where(eq(schema.instagramCommentLogs.companyId, companyA.id))
      assert.equal(logCount.value, 3, 'retry não pode duplicar exclusões manuais')
    })

    await test('duas chamadas concorrentes para o mesmo media_id criam apenas uma linha', async () => {
      const mediaId = 'media-race-condition'
      const [firstResponse, secondResponse] = await Promise.all([
        POST(
          request(companyA.slug, masterKey, {
            media_id: mediaId,
            keyword: 'TRILHA',
            dm_message: 'Mensagem da corrida A',
          }),
          { params: Promise.resolve({ idOrSlug: companyA.slug }) },
        ),
        POST(
          request(companyA.slug, masterKey, {
            media_id: mediaId,
            keyword: 'TRILHA',
            dm_message: 'Mensagem da corrida B',
          }),
          { params: Promise.resolve({ idOrSlug: companyA.slug }) },
        ),
      ])

      assert.equal(firstResponse.status, 200)
      assert.equal(secondResponse.status, 200)
      const [firstBody, secondBody] = await Promise.all([
        firstResponse.json(),
        secondResponse.json(),
      ])
      assert.deepEqual(
        [firstBody.created, secondBody.created].sort(),
        [false, true],
        'em corrida, somente a chamada que inseriu deve responder created=true',
      )

      const [rowCount] = await testDb
        .select({ value: count() })
        .from(schema.instagramCommentAutomations)
        .where(
          and(
            eq(schema.instagramCommentAutomations.companyId, companyA.id),
            eq(schema.instagramCommentAutomations.mediaId, mediaId),
          ),
        )

      assert.equal(rowCount.value, 1, 'requisições concorrentes para o mesmo media_id não podem duplicar')
    })

    await test('all_posts cria e atualiza uma regra global sem tocar na regra da mídia de mesma palavra', async () => {
      const [mediaRule] = await testDb
        .insert(schema.instagramCommentAutomations)
        .values({
          companyId: companyA.id,
          name: 'Regra só desta mídia',
          mediaId: 'media-da-mesma-palavra',
          keywords: 'MATERIAL',
          dmMessage: 'Mensagem exclusiva da mídia',
          isActive: false,
        })
        .returning()

      const created = await POST(
        request(companyA.slug, masterKey, {
          all_posts: true,
          media_id: 'deve-ser-ignorada',
          keyword: '  MATERIAL  ',
          dm_message: 'Mensagem global original',
          name: 'Material em todos os posts',
          match_type: 'exact',
        }),
        { params: Promise.resolve({ idOrSlug: companyA.slug }) },
      )
      const createdBody = await created.json()
      assert.equal(created.status, 200)
      assert.equal(createdBody.created, true)
      assert.equal(createdBody.automation.mediaId, null)
      assert.equal(createdBody.automation.isActive, true)

      await testDb.update(schema.instagramCommentAutomations)
        .set({ isActive: false })
        .where(eq(schema.instagramCommentAutomations.id, createdBody.automation.id))

      const updated = await POST(
        request(companyA.slug, masterKey, {
          all_posts: true,
          keyword: 'material',
          dm_message: 'Mensagem global atualizada',
          name: 'Novo nome global',
          match_type: 'any',
        }),
        { params: Promise.resolve({ idOrSlug: companyA.slug }) },
      )
      const updatedBody = await updated.json()
      assert.equal(updated.status, 200)
      assert.equal(updatedBody.created, false)
      assert.equal(updatedBody.automation.id, createdBody.automation.id)
      assert.equal(updatedBody.automation.isActive, true, 'ensure global reativa a regra encontrada')

      const globalRules = await testDb.select().from(schema.instagramCommentAutomations).where(and(
        eq(schema.instagramCommentAutomations.companyId, companyA.id),
        isNull(schema.instagramCommentAutomations.mediaId),
      ))
      const globalRule = globalRules.find(rule => rule.id === createdBody.automation.id)
      assert.ok(globalRule)
      assert.equal(globalRule.keywords, 'material')
      assert.equal(globalRule.dmMessage, 'Mensagem global atualizada')
      assert.equal(globalRule.name, 'Novo nome global')
      assert.equal(globalRule.matchType, 'any')

      const [unchangedMediaRule] = await testDb.select().from(schema.instagramCommentAutomations)
        .where(eq(schema.instagramCommentAutomations.id, mediaRule.id))
      assert.equal(unchangedMediaRule.dmMessage, 'Mensagem exclusiva da mídia')
      assert.equal(unchangedMediaRule.isActive, false)
    })

    await test('all_posts preserva Direct, both e template e limpa campos herdados da regra comum', async () => {
      const protectedRules = await testDb.insert(schema.instagramCommentAutomations).values([
        { companyId: companyA.id, name: 'Direct', keywords: 'PROTEGIDA', dmMessage: 'Direct intacta', isActive: false, triggerType: 'direct' },
        { companyId: companyA.id, name: 'Both', keywords: 'PROTEGIDA', dmMessage: 'Both intacta', isActive: false, triggerType: 'both' },
        { companyId: companyA.id, name: 'Template', keywords: 'PROTEGIDA', dmMessage: 'Template intacta', isActive: false, templateId: '021126' },
      ]).returning()
      const [legacyGlobal] = await testDb.insert(schema.instagramCommentAutomations).values({
        companyId: companyA.id, name: 'Global antiga', keywords: 'COMEÇAR', dmMessage: 'Antiga', isActive: false,
        publicReply: 'Resposta antiga', requireFollowCheck: true, hideCommentAfterReply: true,
        activeHoursStart: '08:00', activeHoursEnd: '18:00', triggerType: 'comment',
      }).returning()

      const protectedResponse = await POST(request(companyA.slug, masterKey, {
        all_posts: true, keyword: 'protegida', dm_message: 'Nova regra comum',
      }), { params: Promise.resolve({ idOrSlug: companyA.slug }) })
      assert.equal(protectedResponse.status, 200)
      assert.equal((await protectedResponse.json()).created, true)
      const protectedAfter = await testDb.select().from(schema.instagramCommentAutomations)
        .where(eq(schema.instagramCommentAutomations.companyId, companyA.id))
      for (const protectedRule of protectedRules) {
        const after = protectedAfter.find(rule => rule.id === protectedRule.id)
        assert.ok(after)
        assert.equal(after.dmMessage, protectedRule.dmMessage)
        assert.equal(after.isActive, false)
      }

      const accentResponse = await POST(request(companyA.slug, masterKey, {
        all_posts: true, keyword: 'comecar', dm_message: 'Atualizada sem acento',
      }), { params: Promise.resolve({ idOrSlug: companyA.slug }) })
      const accentBody = await accentResponse.json()
      assert.equal(accentResponse.status, 200)
      assert.equal(accentBody.created, false)
      assert.equal(accentBody.automation.id, legacyGlobal.id)
      const [cleaned] = await testDb.select().from(schema.instagramCommentAutomations)
        .where(eq(schema.instagramCommentAutomations.id, legacyGlobal.id))
      assert.equal(cleaned.publicReply, null)
      assert.equal(cleaned.requireFollowCheck, false)
      assert.equal(cleaned.hideCommentAfterReply, false)
      assert.equal(cleaned.activeHoursStart, null)
      assert.equal(cleaned.activeHoursEnd, null)
    })

    await test('all_posts suporta chamadas simultâneas pela palavra normalizada', async () => {
      const [first, second] = await Promise.all([
        POST(request(companyA.slug, masterKey, { all_posts: true, keyword: '  GLOBAL CORRIDA ', dm_message: 'A' }), { params: Promise.resolve({ idOrSlug: companyA.slug }) }),
        POST(request(companyA.slug, masterKey, { all_posts: true, keyword: 'global corrida', dm_message: 'B' }), { params: Promise.resolve({ idOrSlug: companyA.slug }) }),
      ])
      const [firstBody, secondBody] = await Promise.all([first.json(), second.json()])
      assert.equal(first.status, 200)
      assert.equal(second.status, 200)
      assert.ok([firstBody.created, secondBody.created].every(created => typeof created === 'boolean'))

      const rows = await testDb.select().from(schema.instagramCommentAutomations).where(and(
        eq(schema.instagramCommentAutomations.companyId, companyA.id),
        isNull(schema.instagramCommentAutomations.mediaId),
      ))
      assert.ok(rows.filter(row => row.keywords?.trim().toLowerCase() === 'global corrida').length >= 1)
    })

    await test('all_posts inválido retorna 400 e sem all_posts continua exigindo media_id', async () => {
      const invalid = await POST(
        request(companyA.slug, masterKey, { all_posts: 'true', keyword: 'X', dm_message: 'Y' }),
        { params: Promise.resolve({ idOrSlug: companyA.slug }) },
      )
      assert.equal(invalid.status, 400)
      assert.equal((await invalid.json()).error, 'O campo all_posts deve ser booleano.')

      const legacy = await POST(
        request(companyA.slug, masterKey, { keyword: 'X', dm_message: 'Y' }),
        { params: Promise.resolve({ idOrSlug: companyA.slug }) },
      )
      assert.equal(legacy.status, 400)
      assert.match((await legacy.json()).error, /media_id/)
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
