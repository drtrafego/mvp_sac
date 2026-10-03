// Teste de regressão para ITEM 8:
// "Origens de Aquisição" deve agrupar leads novos no período por firstContactAt,
// e não qualquer lead antigo com atividade recente no período.
//
// Execução:
// node --import tsx scripts/dashboard-origin-first-contact.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'dashboard_origin_first_contact_test'

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
      if (addr && typeof addr === 'object') {
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
  console.log(`[setup] subindo postgres:16-alpine descartável na porta ${port}...`)
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
  console.log('[setup] aplicando schema real...')
  execFileSync('npx', ['drizzle-kit', 'push', '--force'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  })
}

test('trafficBreakdown por origem ignora lead antigo com atividade recente no período', async () => {
  const fromDate = new Date('2026-10-01T00:00:00-03:00')
  const toDate = new Date('2026-10-01T23:59:59.999-03:00')
  const fromDateSql = fromDate.toISOString()
  const toDateSql = toDate.toISOString()

  if (dockerAvailable()) {
    const disposable = await startDisposablePostgres()
    try {
      applyRealSchema(disposable.url)
      const sqlClient = postgres(disposable.url)
      const testDb = drizzle(sqlClient, { schema })

      const [company] = await testDb
        .insert(schema.companies)
        .values({ name: 'Origem First Contact Teste', slug: 'origem-first-contact-teste' })
        .returning()

      await testDb.insert(schema.recoveryLeads).values({
        companyId: company.id,
        phone: '5554999991001',
        name: 'Lead Meta Novo',
        eventType: 'carrinho_abandonado',
        trackingSource: 'Meta Ads',
        firstContactAt: new Date('2026-10-01T10:00:00-03:00'),
        createdAt: new Date('2026-10-01T10:00:00-03:00'),
        lastActionAt: new Date('2026-10-01T10:05:00-03:00'),
        platform: 'whatsapp',
        status: 'open',
      })

      await testDb.insert(schema.recoveryLeads).values({
        companyId: company.id,
        phone: '5554999991002',
        name: 'Lead Meta Antigo com Atividade',
        eventType: 'carrinho_abandonado',
        trackingSource: 'Meta Ads',
        firstContactAt: new Date('2026-09-20T14:00:00-03:00'),
        createdAt: new Date('2026-09-20T14:00:00-03:00'),
        lastActionAt: new Date('2026-10-01T15:30:00-03:00'),
        updatedAt: new Date('2026-10-01T15:30:00-03:00'),
        platform: 'whatsapp',
        status: 'open',
      })

      await testDb.insert(schema.recoveryLeads).values({
        companyId: company.id,
        phone: '5554999991003',
        name: 'Lead Orgânico Novo',
        eventType: 'carrinho_abandonado',
        trackingSource: 'Organico',
        firstContactAt: new Date('2026-10-01T11:00:00-03:00'),
        createdAt: new Date('2026-10-01T11:00:00-03:00'),
        lastActionAt: new Date('2026-10-01T11:05:00-03:00'),
        platform: 'whatsapp',
        status: 'open',
      })

      const oldRows = await sqlClient<{ source: string; count: number }[]>`
        select
          coalesce(nullif(tracking_source, ''), nullif(platform, ''), 'Direto / Orgânico') as source,
          cast(count(*) as int) as count
        from recovery_leads
        where company_id = ${company.id}
          and coalesce(last_action_at, updated_at, created_at) >= ${fromDateSql}::timestamp
          and coalesce(last_action_at, updated_at, created_at) <= ${toDateSql}::timestamp
        group by source
        order by count(*) desc
      `

      const newRows = await sqlClient<{ source: string; count: number }[]>`
        select
          coalesce(nullif(tracking_source, ''), nullif(platform, ''), 'Direto / Orgânico') as source,
          cast(count(*) as int) as count
        from recovery_leads
        where company_id = ${company.id}
          and first_contact_at >= ${fromDateSql}::timestamp
          and first_contact_at <= ${toDateSql}::timestamp
        group by source
        order by count(*) desc
      `

      assert.equal(Number(oldRows.find(row => row.source === 'Meta Ads')?.count ?? 0), 2)
      assert.equal(Number(newRows.find(row => row.source === 'Meta Ads')?.count ?? 0), 1)
      assert.equal(Number(newRows.find(row => row.source === 'Organico')?.count ?? 0), 1)

      await sqlClient.end()
    } finally {
      disposable.stop()
    }
  } else {
    const leads = [
      {
        id: 1,
        source: 'Meta Ads',
        firstContactAt: new Date('2026-10-01T10:00:00-03:00'),
        lastActionAt: new Date('2026-10-01T10:05:00-03:00'),
        updatedAt: null as Date | null,
        createdAt: new Date('2026-10-01T10:00:00-03:00'),
      },
      {
        id: 2,
        source: 'Meta Ads',
        firstContactAt: new Date('2026-09-20T14:00:00-03:00'),
        lastActionAt: new Date('2026-10-01T15:30:00-03:00'),
        updatedAt: new Date('2026-10-01T15:30:00-03:00'),
        createdAt: new Date('2026-09-20T14:00:00-03:00'),
      },
      {
        id: 3,
        source: 'Organico',
        firstContactAt: new Date('2026-10-01T11:00:00-03:00'),
        lastActionAt: new Date('2026-10-01T11:05:00-03:00'),
        updatedAt: null as Date | null,
        createdAt: new Date('2026-10-01T11:00:00-03:00'),
      },
    ]

    const oldMetaCount = leads.filter(lead => {
      const activityDate = lead.lastActionAt || lead.updatedAt || lead.createdAt
      return lead.source === 'Meta Ads' && activityDate >= fromDate && activityDate <= toDate
    }).length

    const newMetaCount = leads.filter(lead => {
      return lead.source === 'Meta Ads' && lead.firstContactAt >= fromDate && lead.firstContactAt <= toDate
    }).length

    assert.equal(oldMetaCount, 2, 'Lógica antiga contava lead Meta antigo por atividade recente')
    assert.equal(newMetaCount, 1, 'Lógica nova conta só lead Meta com firstContactAt no período')
  }
})
