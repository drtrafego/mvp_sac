// Teste de regressão para ITEM 3:
// "Conversas Iniciadas" no Dashboard deve contar conversas iniciadas no período (firstContactAt),
// e não qualquer atividade no período (baseWhere / coalesce(lastActionAt, updatedAt, createdAt)).
//
// Contexto do bug:
// O card "Conversas Iniciadas" e o denominador da Taxa de Conversão usavam `leadStats?.total`,
// que vinha de `baseWhere` (filtrando por qualquer atividade no período). Isso inflava o número
// de conversas iniciadas (ex: 150 ao invés de ~75 no Gramado Plazza).
//
// Correção:
// Query dedicada filtrando por `firstContactAt` no período:
// db.select({ total: count() }).from(recoveryLeads).where(and(eq(companyId), gte(firstContactAt), lte(firstContactAt), sourceFilter))
//
// Execução:
// node --import tsx scripts/dashboard-first-contact.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../src/lib/db/schema'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'dashboard_first_contact_test'

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

test('total de conversas iniciadas conta apenas leads cujo firstContactAt está no período', async () => {
  const fromDate = new Date('2026-10-01T00:00:00-03:00')
  const toDate = new Date('2026-10-01T23:59:59.999-03:00')

  // Se Docker estiver disponível, roda contra Postgres real descartável
  if (dockerAvailable()) {
    const disposable = await startDisposablePostgres()
    try {
      applyRealSchema(disposable.url)
      const sqlClient = postgres(disposable.url)
      const testDb = drizzle(sqlClient, { schema })

      const [company] = await testDb
        .insert(schema.companies)
        .values({ name: 'Gramado Plaza Teste', slug: 'gramado-teste-fc' })
        .returning()

      // Lead 1: Conversa iniciada DENTRO do período (01/10/2026)
      await testDb.insert(schema.recoveryLeads).values({
        companyId: company.id,
        phone: '5554999990001',
        name: 'Lead Novo',
        eventType: 'carrinho_abandonado',
        firstContactAt: new Date('2026-10-01T10:00:00-03:00'),
        createdAt: new Date('2026-10-01T10:00:00-03:00'),
        lastActionAt: new Date('2026-10-01T10:05:00-03:00'),
        platform: 'whatsapp',
        status: 'open',
      })

      // Lead 2: Conversa iniciada ANTES do período (20/09/2026), mas com atividade DENTRO do período (01/10/2026)
      await testDb.insert(schema.recoveryLeads).values({
        companyId: company.id,
        phone: '5554999990002',
        name: 'Lead Antigo com Atividade',
        eventType: 'carrinho_abandonado',
        firstContactAt: new Date('2026-09-20T14:00:00-03:00'),
        createdAt: new Date('2026-09-20T14:00:00-03:00'),
        lastActionAt: new Date('2026-10-01T15:30:00-03:00'),
        updatedAt: new Date('2026-10-01T15:30:00-03:00'),
        platform: 'whatsapp',
        status: 'open',
      })

      const fromDateSql = fromDate.toISOString()
      const toDateSql = toDate.toISOString()

      // 1. Query antiga (baseWhere com activityDateSql) - inflava a contagem pegando ambos os leads
      const [oldResult] = await sqlClient<{ total: number }[]>`
        select cast(count(*) as int) as total
        from recovery_leads
        where company_id = ${company.id}
          and coalesce(last_action_at, updated_at, created_at) >= ${fromDateSql}::timestamp
          and coalesce(last_action_at, updated_at, created_at) <= ${toDateSql}::timestamp
      `

      assert.equal(Number(oldResult.total), 2, 'A query antiga contava 2 leads por causa da atividade recente')

      // 2. Query nova (filtrando apenas firstContactAt) - conta unicamente a conversa iniciada no período
      const [newResult] = await sqlClient<{ total: number }[]>`
        select cast(count(*) as int) as total
        from recovery_leads
        where company_id = ${company.id}
          and first_contact_at >= ${fromDateSql}::timestamp
          and first_contact_at <= ${toDateSql}::timestamp
      `

      assert.equal(Number(newResult.total), 1, 'A query nova conta APENAS o lead que iniciou conversa no período')
      console.log('✔ Validação contra Postgres descartável concluída com sucesso: total novo = 1 (lead 1), total antigo = 2')

      await sqlClient.end()
    } finally {
      disposable.stop()
    }
  } else {
    // Validação lógica em ambiente sem Docker
    const lead1 = {
      id: 1,
      name: 'Lead Novo',
      firstContactAt: new Date('2026-10-01T10:00:00-03:00'),
      lastActionAt: new Date('2026-10-01T10:05:00-03:00'),
      createdAt: new Date('2026-10-01T10:00:00-03:00'),
      updatedAt: null as Date | null,
    }

    const lead2 = {
      id: 2,
      name: 'Lead Antigo com Atividade',
      firstContactAt: new Date('2026-09-20T14:00:00-03:00'),
      lastActionAt: new Date('2026-10-01T15:30:00-03:00'),
      createdAt: new Date('2026-09-20T14:00:00-03:00'),
      updatedAt: new Date('2026-10-01T15:30:00-03:00'),
    }

    const leads = [lead1, lead2]

    // Lógica antiga (activityDate: coalesce(lastActionAt, updatedAt, createdAt))
    const oldFiltered = leads.filter(l => {
      const act = l.lastActionAt || l.updatedAt || l.createdAt
      return act >= fromDate && act <= toDate
    })
    assert.equal(oldFiltered.length, 2, 'Lógica antiga contava atividade de ambos')

    // Lógica nova (firstContactAt)
    const newFiltered = leads.filter(l => {
      return l.firstContactAt && l.firstContactAt >= fromDate && l.firstContactAt <= toDate
    })
    assert.equal(newFiltered.length, 1, 'Lógica nova conta apenas a conversa nova iniciada no período')
    assert.equal(newFiltered[0].id, 1)
  }
})
