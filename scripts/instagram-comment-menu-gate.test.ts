import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'instagram_comment_menu_gate_test'
const COMMENT_TO_DM_HREF = '/comentarios-instagram'

function dockerAvailable(): boolean {
  return spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
}

async function pickFreePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Porta livre indisponível.')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await pickFreePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ], { stdio: 'ignore' })

  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const probe = postgres(url, { max: 1, connect_timeout: 2 })
    try {
      await probe`select 1`
      await probe.end({ timeout: 1 })
      return {
        url,
        stop: () => { spawnSync('docker', ['rm', '-f', '-v', CONTAINER_NAME], { stdio: 'ignore' }) },
      }
    } catch {
      await probe.end({ timeout: 1 }).catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  }
  throw new Error('Postgres descartável não respondeu a tempo.')
}

function hasCommentToDmItem(items: readonly { href: string }[]): boolean {
  return items.some(item => item.href === COMMENT_TO_DM_HREF)
}

async function main() {
  if (!dockerAvailable()) throw new Error('Docker é obrigatório para este teste.')

  const disposable = await startPostgres()
  const sql = postgres(disposable.url)

  try {
    execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: disposable.url },
      stdio: 'ignore',
    })

    const database = drizzle(sql, { schema })
    await database.insert(schema.companies).values([
      { id: 301, name: 'Sem automação', slug: 'sem-automacao' },
      { id: 302, name: 'Automação ativa', slug: 'automacao-ativa' },
      { id: 303, name: 'Automação pausada', slug: 'automacao-pausada' },
    ])
    await database.insert(schema.settings).values([301, 302, 303].map(companyId => ({
      companyId,
      instagramAccountId: `ig-${companyId}`,
      instagramAccessToken: `token-${companyId}`,
    })))
    await database.insert(schema.instagramCommentAutomations).values([
      {
        companyId: 302,
        name: 'Regra ativa',
        dmMessage: 'Mensagem ativa',
        isActive: true,
      },
      {
        companyId: 303,
        name: 'Regra pausada',
        dmMessage: 'Mensagem pausada',
        isActive: false,
      },
    ])

    mock.module('@/lib/db', { namedExports: { db: database } })

    const { getCompanySidebarData } = await import('../src/lib/company-sidebar')
    const {
      atendimentoNav,
      instagramNav,
      filterAvailableNavItems,
    } = await import('../src/components/layout/sidebar')

    await test('empresa sem automação esconde Comentário → DM nas duas seções', async () => {
      const { activeConnections } = await getCompanySidebarData(301)
      assert.equal(activeConnections.instagram, true, 'pré-condição: Instagram Direct está configurado')
      assert.equal(activeConnections.instagramCommentAutomation, false)
      assert.equal(hasCommentToDmItem(filterAvailableNavItems(atendimentoNav, activeConnections)), false)
      assert.equal(hasCommentToDmItem(filterAvailableNavItems(instagramNav, activeConnections)), false)
    })

    await test('empresa com automação ativa mantém Comentário → DM visível nas duas seções', async () => {
      const { activeConnections } = await getCompanySidebarData(302)
      assert.equal(activeConnections.instagramCommentAutomation, true)
      assert.equal(hasCommentToDmItem(filterAvailableNavItems(atendimentoNav, activeConnections)), true)
      assert.equal(hasCommentToDmItem(filterAvailableNavItems(instagramNav, activeConnections)), true)
    })

    await test('empresa com automação pausada esconde Comentário → DM nas duas seções', async () => {
      const { activeConnections } = await getCompanySidebarData(303)
      assert.equal(activeConnections.instagramCommentAutomation, false)
      assert.equal(hasCommentToDmItem(filterAvailableNavItems(atendimentoNav, activeConnections)), false)
      assert.equal(hasCommentToDmItem(filterAvailableNavItems(instagramNav, activeConnections)), false)
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
