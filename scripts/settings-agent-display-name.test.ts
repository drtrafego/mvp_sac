// Regressão da edição do nome do bot em /api/settings contra Postgres real.
// Uso: pnpm test:settings-agent-display-name

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'settings_agent_display_name_test'

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
        server.close(() => reject(new Error('Não foi possível alocar uma porta livre.')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
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
        stop: () => { spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' }) },
      }
    } catch {
      await probe.end({ timeout: 1 })
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }
  throw new Error('Postgres descartável não respondeu a tempo.')
}

async function main() {
  if (!dockerAvailable()) throw new Error('Docker é obrigatório para este teste.')

  const disposable = await startPostgres()
  const sql = postgres(disposable.url)

  try {
    execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: disposable.url },
      stdio: 'inherit',
    })

    const [seededCompany] = await sql`
      insert into companies (name, slug, plan, agent_display_name)
      values ('Empresa teste', 'empresa-teste', 'pro', 'Nome sincronizado')
      returning *
    `
    const database = drizzle(sql, { schema })

    mock.module('@/lib/db', { namedExports: { db: database } })
    mock.module('@/lib/auth', {
      namedExports: {
        requireCompany: async () => {
          const [company] = await database
            .select()
            .from(schema.companies)
            .where(eq(schema.companies.id, seededCompany.id))
          return company
        },
        getCurrentUser: async () => null,
      },
    })

    const { GET, PUT } = await import('../src/app/api/settings/route')
    const { NextRequest } = await import('next/server')

    await test('salva e relê o nome editado pelo mesmo fluxo de /api/settings', async () => {
      const putResponse = await PUT(new NextRequest('http://localhost/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentDisplayName: '  Clara Editada  ', brevoSenderName: 'SAC Teste' }),
      }))
      assert.equal(putResponse.status, 200)
      assert.equal((await putResponse.json()).agentDisplayName, 'Clara Editada')

      const getResponse = await GET()
      assert.equal(getResponse.status, 200)
      const reread = await getResponse.json()
      assert.equal(reread.agentDisplayName, 'Clara Editada')
      assert.equal(reread.brevoSenderName, 'SAC Teste')

      const [stored] = await sql`
        select agent_display_name, agent_display_name_manual
        from companies where id = ${seededCompany.id}
      `
      assert.equal(stored.agent_display_name, 'Clara Editada')
      assert.equal(stored.agent_display_name_manual, true)
    })

    await test('rejeita nome vazio ou longo sem apagar o valor persistido', async () => {
      for (const invalidName of ['   ', 'x'.repeat(81)]) {
        const response = await PUT(new NextRequest('http://localhost/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ agentDisplayName: invalidName }),
        }))
        assert.equal(response.status, 400)
      }

      const reread = await (await GET()).json()
      assert.equal(reread.agentDisplayName, 'Clara Editada')
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
