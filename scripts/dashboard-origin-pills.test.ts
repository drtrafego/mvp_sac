import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'
import { loadDashboardOriginPills } from '../src/lib/dashboard/origin-pills'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'dashboard_origin_pills_test'

async function freePort(): Promise<number> {
  const net = await import('node:net')
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('porta livre indisponível'))
      server.close(() => resolve(address.port))
    })
  })
}

async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    throw new Error('Docker não disponível: o teste exige Postgres descartável real')
  }

  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
  const port = await freePort()
  execFileSync('docker', [
    'run', '--rm', '-d', '--name', CONTAINER_NAME,
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=test',
    '-p', `127.0.0.1:${port}:5432`, 'postgres:16-alpine',
  ])

  const url = `postgres://postgres:test@127.0.0.1:${port}/test`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const probe = postgres(url, { max: 1, connect_timeout: 2 })
    try {
      await probe`select 1`
      await probe.end({ timeout: 1 })
      return { url, stop: () => { spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' }) } }
    } catch {
      await probe.end({ timeout: 1 }).catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  }
  throw new Error('Postgres descartável não respondeu')
}

function lead(companyId: number, phone: string, values: Partial<typeof schema.recoveryLeads.$inferInsert>) {
  return {
    companyId,
    phone,
    eventType: 'atendimento_ia',
    platform: 'sac',
    status: 'active',
    ...values,
  }
}

async function main() {
  const disposable = await startPostgres()
  try {
    execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DATABASE_URL: disposable.url },
      stdio: 'ignore',
    })

    const sql = postgres(disposable.url)
    const testDb = drizzle(sql, { schema })
    try {
      await testDb.insert(schema.companies).values([
        { id: 292, name: 'AutonomIA', slug: 'autonomia' },
        { id: 999, name: 'Outra Empresa', slug: 'outra-empresa' },
      ])

      await testDb.insert(schema.recoveryLeads).values([
        lead(292, '5511900000001', { trackingSource: 'mineracao_prospeccao', channel: 'email', productName: 'Treinamento Kiwify' }),
        lead(292, '5511900000002', { trackingSource: 'meta_ads', channel: 'whatsapp' }),
        lead(292, '5511900000003', { trackingSource: 'instagram_direct', channel: 'instagram' }),
        lead(292, '5511900000004', { trackingSource: 'hotmart', platform: 'hotmart' }),
        lead(292, '5511900000008', { trackingSource: 'comparativo_kiwify', platform: 'sac' }),
        lead(999, '5511900000005', { trackingSource: 'kiwify', platform: 'kiwify' }),
        lead(999, '5511900000006', { trackingSource: 'google_ads' }),
      ])

      const autonomia = await loadDashboardOriginPills(testDb, 292)
      assert.deepEqual([...autonomia.categories].sort(), ['anuncio', 'hotmart', 'instagram', 'mineracao'])
      assert.deepEqual([...autonomia.anuncioSubcategories], ['meta_ads'])
      assert.equal(autonomia.categories.has('kiwify'), false, 'Kiwify de outro tenant ou só no product_name não pode vazar')

      const outra = await loadDashboardOriginPills(testDb, 999)
      assert.deepEqual([...outra.categories].sort(), ['anuncio', 'kiwify'])
      assert.deepEqual([...outra.anuncioSubcategories], ['google_ads'])

      await testDb.insert(schema.recoveryLeads).values(
        lead(292, '5511900000007', { trackingSource: 'google_ads' }),
      )
      const comGoogle = await loadDashboardOriginPills(testDb, 292)
      assert.equal(comGoogle.categories.has('anuncio'), true)
      assert.deepEqual([...comGoogle.anuncioSubcategories].sort(), ['google_ads', 'meta_ads'])
    } finally {
      await sql.end({ timeout: 2 })
    }
  } finally {
    disposable.stop()
  }

  console.log('OK: pills são tenant-bound, data-driven e Anúncio agrupa Meta/Google Ads.')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
