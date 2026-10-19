import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'instagram_inbound_tags_test'

function dockerAvailable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') server.close(() => resolve(address.port))
      else reject(new Error('Não foi possível reservar uma porta para o Postgres de teste.'))
    })
  })
}

async function startPostgres() {
  spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await freePort()
  execFileSync('docker', ['run', '--rm', '-d', '--name', CONTAINER_NAME, '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test', '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine'])
  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const probe = postgres(url, { max: 1, connect_timeout: 2 })
      await probe`select 1`
      await probe.end({ timeout: 1 })
      return { url, stop: () => spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' }) }
    } catch {
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
  throw new Error('Postgres descartável não respondeu a tempo.')
}

test('cada interação Instagram cria ou atualiza um único lead e aplica sua tag uma vez', async (t) => {
  if (!dockerAvailable()) return t.skip('Docker não disponível')
  const disposable = await startPostgres()
  t.after(() => disposable.stop())

  execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: disposable.url },
    stdio: 'inherit',
  })

  const sql = postgres(disposable.url)
  t.after(() => sql.end({ timeout: 1 }))
  const testDb = drizzle(sql, { schema })
  mock.module('@/lib/db', { namedExports: { db: testDb } })

  const [company] = await testDb.insert(schema.companies).values({ name: 'Teste Instagram', slug: 'teste-instagram-tags' }).returning()
  const { captureInstagramInboundInteraction, isInstagramEntryForCompany, isInstagramStoryReaction } = await import('../src/lib/instagram-inbound-tags')
  const storyReaction = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'scripts/fixtures/instagram-story-reaction.json'), 'utf8')) as { value: Record<string, unknown> }
  const dmReaction = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'scripts/fixtures/instagram-dm-reaction.json'), 'utf8')) as { value: Record<string, unknown> }

  assert.equal(isInstagramStoryReaction(storyReaction.value), true, 'a reação vinculada à Story recebe a tag de Story')
  assert.equal(isInstagramStoryReaction(dmReaction.value), false, 'a reação de DM não pode receber uma tag de Story')
  assert.equal(isInstagramEntryForCompany('CONTA_A', { instagramAccountId: 'CONTA_A', instagramPageId: 'PAGINA_A' }), true)
  assert.equal(isInstagramEntryForCompany('CONTA_B', { instagramAccountId: 'CONTA_A', instagramPageId: 'PAGINA_A' }), false, 'payload da conta B é recusado na rota da empresa A')
  const interactions = ['comment', 'direct', 'story_reply', 'story_reaction'] as const

  for (const interaction of interactions) {
    await captureInstagramInboundInteraction({ companyId: company.id, instagramUserId: '17890000001', username: 'cliente', interaction })
    await captureInstagramInboundInteraction({ companyId: company.id, instagramUserId: '17890000001', username: 'cliente', interaction })
  }

  const leads = await testDb.select().from(schema.recoveryLeads).where(and(eq(schema.recoveryLeads.companyId, company.id), eq(schema.recoveryLeads.phone, 'ig_17890000001')))
  assert.equal(leads.length, 1, 'reentregas e eventos diferentes reutilizam o mesmo lead')

  const tags = await testDb.select().from(schema.leadTags).where(eq(schema.leadTags.leadId, leads[0].id))
  assert.deepEqual(tags.map(tag => tag.tag).sort(), [
    'instagram_comentario',
    'instagram_direct',
    'instagram_reacao_story',
    'instagram_resposta_story',
  ])
  assert.equal(tags.length, 4, 'a chave única impede duplicar tags em reentregas')
})
