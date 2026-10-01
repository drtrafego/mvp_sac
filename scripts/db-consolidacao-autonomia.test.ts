// Teste da consolidação atômica AutonomIA (src/lib/db/index.ts,
// consolidateAutonomiaCompany), achado A07 P0 da auditoria Codex/gpt-6-astra
// de 26/09/2026: a versão antiga rodava a transferência de leads/mensagens
// e o DELETE definitivo de gastao-matos como 5 statements soltos dentro de
// um Promise.allSettled, sem ordem garantida e sem transação — uma falha
// silenciosa na transferência não impedia o DELETE em cascata (FKs com
// ON DELETE CASCADE) de rodar, podendo apagar lead/mensagem de cliente real
// que nunca chegou a ser migrado.
//
// Mesmo padrão de scripts/hermes-conversion-webhook.test.ts: sobe um
// Postgres DESCARTÁVEL de verdade via Docker, aplica o schema real do
// projeto via `drizzle-kit push`, e chama consolidateAutonomiaCompany
// diretamente contra um client postgres-js real (a função aceita
// `client: any` e só usa tagged template, mesma interface do client neon
// de produção).
//
// Casos cobertos (pedidos na tarefa):
//   (a) cenário de sucesso completo: transfere leads/mensagens de
//       gastao-matos E casaldotrafego pra autonomia, apaga company_members/
//       settings/companies de gastao-matos, casaldotrafego permanece.
//   (b) cenário de falha simulada no MEIO da transferência (trigger derruba
//       a atualização de uma whatsapp_message específica): confirma que
//       NADA foi apagado nem transferido, rollback total da transação.
//   (c) depois de corrigida a falha simulada, rodar de novo consolida
//       normalmente (a origem preservada em (b) não ficou orfã).
//   (d) rodar consolidateAutonomiaCompany uma terceira vez, já sem
//       gastao-matos/casaldotrafego pendentes: idempotente, não erra, não
//       mexe em nada.
//
// Uso: npx tsx --test scripts/db-consolidacao-autonomia.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { consolidateAutonomiaCompany } from '../src/lib/db'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'db_consolidacao_autonomia_test'

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

  try {
    // ── (a) cenário de sucesso completo ───────────────────────────────────
    await test('sucesso completo: transfere tudo, apaga gastao-matos, casaldotrafego permanece', async () => {
      const [gastao] = await sql`INSERT INTO companies (name, slug, plan) VALUES ('Gastão Matos', 'gastao-matos', 'pro') RETURNING id`
      const [casal] = await sql`INSERT INTO companies (name, slug, plan) VALUES ('Casal do Tráfego', 'casaldotrafego', 'pro') RETURNING id`

      await sql`INSERT INTO recovery_leads (company_id, phone, platform, event_type) SELECT ${gastao.id}, 'lead-gastao-' || g, 'sac', 'atendimento' FROM generate_series(1, 3) g`
      await sql`INSERT INTO recovery_leads (company_id, phone, platform, event_type) SELECT ${casal.id}, 'lead-casal-' || g, 'sac', 'atendimento' FROM generate_series(1, 2) g`
      await sql`INSERT INTO whatsapp_messages (company_id, phone, direction, content) SELECT ${gastao.id}, 'msg-gastao-' || g, 'inbound', 'oi' FROM generate_series(1, 4) g`
      await sql`INSERT INTO company_members (company_id, email, role, status) VALUES (${gastao.id}, 'admin@gastao-teste.com', 'admin', 'ativo')`
      await sql`INSERT INTO settings (company_id) VALUES (${gastao.id})`

      await consolidateAutonomiaCompany(sql)

      const [autonomia] = await sql`SELECT id FROM companies WHERE slug = 'autonomia'`
      assert.ok(autonomia, 'deveria ter criado a empresa autonomia')

      const [gastaoAinda] = await sql`SELECT id FROM companies WHERE slug = 'gastao-matos'`
      assert.equal(gastaoAinda, undefined, 'gastao-matos deveria ter sido apagada')

      const [casalAinda] = await sql`SELECT id FROM companies WHERE id = ${casal.id}`
      assert.ok(casalAinda, 'casaldotrafego NÃO deveria ser apagada, só tem os dados transferidos')

      const leadsNaAutonomia = await sql`SELECT count(*)::int AS n FROM recovery_leads WHERE company_id = ${autonomia.id}`
      assert.equal(leadsNaAutonomia[0].n, 5, 'os 3 leads do gastao + 2 do casal deveriam estar na autonomia')

      const mensagensNaAutonomia = await sql`SELECT count(*)::int AS n FROM whatsapp_messages WHERE company_id = ${autonomia.id}`
      assert.equal(mensagensNaAutonomia[0].n, 4, 'as 4 mensagens do gastao deveriam estar na autonomia')

      const membrosDoGastao = await sql`SELECT count(*)::int AS n FROM company_members WHERE company_id = ${gastao.id}`
      assert.equal(membrosDoGastao[0].n, 0, 'company_members de gastao-matos deveria ter sido apagado')

      const settingsDoGastao = await sql`SELECT count(*)::int AS n FROM settings WHERE company_id = ${gastao.id}`
      assert.equal(settingsDoGastao[0].n, 0, 'settings de gastao-matos deveria ter sido apagado')
    })

    // ── (b) falha simulada NO MEIO da transferência -> rollback total ─────
    await test('falha simulada na transferência de mensagens -> NADA é apagado (rollback total)', async () => {
      // Limpa o estado do cenário (a) e recria do zero um novo gastao-matos/
      // casaldotrafego, já que o (a) apagou a empresa gastao-matos.
      await sql`DELETE FROM recovery_leads`
      await sql`DELETE FROM whatsapp_messages`
      await sql`DELETE FROM company_members`
      await sql`DELETE FROM settings`
      await sql`DELETE FROM companies`

      const [gastao] = await sql`INSERT INTO companies (name, slug, plan) VALUES ('Gastão Matos', 'gastao-matos', 'pro') RETURNING id`
      await sql`INSERT INTO companies (name, slug, plan) VALUES ('Casal do Tráfego', 'casaldotrafego', 'pro')`

      await sql`INSERT INTO recovery_leads (company_id, phone, platform, event_type) SELECT ${gastao.id}, 'lead-gastao-' || g, 'sac', 'atendimento' FROM generate_series(1, 3) g`
      await sql`INSERT INTO whatsapp_messages (company_id, phone, direction, content) SELECT ${gastao.id}, 'msg-gastao-' || g, 'inbound', 'oi' || g FROM generate_series(1, 4) g`
      await sql`INSERT INTO company_members (company_id, email, role, status) VALUES (${gastao.id}, 'admin@gastao-teste.com', 'admin', 'ativo')`
      await sql`INSERT INTO settings (company_id) VALUES (${gastao.id})`

      // Trigger que simula uma falha real de infra a meio caminho da
      // transferência: a 3ª mensagem (content = 'oi3') derruba o UPDATE.
      await sql`
        CREATE OR REPLACE FUNCTION fail_on_third_message() RETURNS trigger AS $$
        BEGIN
          IF NEW.content = 'oi3' THEN
            RAISE EXCEPTION 'falha simulada de infra na transferencia de mensagens';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `
      await sql`
        CREATE TRIGGER trg_fail_on_third_message
        BEFORE UPDATE ON whatsapp_messages
        FOR EACH ROW EXECUTE FUNCTION fail_on_third_message()
      `

      const antes = {
        companies: await sql`SELECT slug FROM companies ORDER BY slug`,
        leads: await sql`SELECT company_id, phone FROM recovery_leads ORDER BY phone`,
        mensagens: await sql`SELECT company_id, content FROM whatsapp_messages ORDER BY content`,
        membros: await sql`SELECT company_id, email FROM company_members`,
        settings: await sql`SELECT company_id FROM settings`,
      }

      // consolidateAutonomiaCompany tem try/catch interno (console.error, pra
      // não derrubar ensureSchema em produção quando isto roda no request
      // path): a chamada NÃO deve lançar mesmo com a trigger de falha
      // simulada ativa. O que prova o rollback é o estado do banco depois,
      // checado logo abaixo, idêntico byte a byte ao de antes.
      await consolidateAutonomiaCompany(sql)

      const depois = {
        companies: await sql`SELECT slug FROM companies ORDER BY slug`,
        leads: await sql`SELECT company_id, phone FROM recovery_leads ORDER BY phone`,
        mensagens: await sql`SELECT company_id, content FROM whatsapp_messages ORDER BY content`,
        membros: await sql`SELECT company_id, email FROM company_members`,
        settings: await sql`SELECT company_id FROM settings`,
      }

      assert.deepEqual(depois.companies, antes.companies, 'nenhuma empresa deveria ter mudado (nem autonomia deveria ter sido criada de forma órfã)')
      assert.deepEqual(depois.leads, antes.leads, 'recovery_leads não pode ter sido tocado: rollback total')
      assert.deepEqual(depois.mensagens, antes.mensagens, 'whatsapp_messages não pode ter sido tocado: rollback total')
      assert.deepEqual(depois.membros, antes.membros, 'company_members de gastao-matos NÃO pode ter sido apagado sem a transferência ter sucesso')
      assert.deepEqual(depois.settings, antes.settings, 'settings de gastao-matos NÃO pode ter sido apagado sem a transferência ter sucesso')

      // Remove a trigger de falha simulada pro próximo teste.
      await sql`DROP TRIGGER trg_fail_on_third_message ON whatsapp_messages`
      await sql`DROP FUNCTION fail_on_third_message()`
    })

    // ── (c) depois de corrigida a falha, roda normalmente ──────────────────
    await test('depois de remover a falha simulada, a consolidação roda normalmente', async () => {
      await consolidateAutonomiaCompany(sql)

      const [autonomia] = await sql`SELECT id FROM companies WHERE slug = 'autonomia'`
      assert.ok(autonomia, 'autonomia deveria existir depois da consolidação bem-sucedida')

      const [gastaoAinda] = await sql`SELECT id FROM companies WHERE slug = 'gastao-matos'`
      assert.equal(gastaoAinda, undefined, 'gastao-matos deveria ter sido apagada desta vez (sem a falha simulada)')

      const leadsNaAutonomia = await sql`SELECT count(*)::int AS n FROM recovery_leads WHERE company_id = ${autonomia.id}`
      assert.equal(leadsNaAutonomia[0].n, 3, 'os leads preservados no cenário (b) deveriam ter sido migrados agora')

      const mensagensNaAutonomia = await sql`SELECT count(*)::int AS n FROM whatsapp_messages WHERE company_id = ${autonomia.id}`
      assert.equal(mensagensNaAutonomia[0].n, 4, 'as mensagens preservadas no cenário (b) deveriam ter sido migradas agora')
    })

    // ── (d) idempotência: rodar sem nada pendente não erra e não mexe em nada ─
    await test('rodar de novo sem gastao-matos/casaldotrafego pendentes é um no-op seguro', async () => {
      const antes = await sql`SELECT slug FROM companies ORDER BY slug`

      await consolidateAutonomiaCompany(sql)

      const depois = await sql`SELECT slug FROM companies ORDER BY slug`
      assert.deepEqual(depois, antes, 'sem gastao-matos/casaldotrafego pendentes, nada deveria mudar')
    })
  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    console.log('\nOK: todos os cenários da consolidação atômica AutonomIA rodaram contra Postgres descartável real.')
  })
  .catch(err => {
    console.error('Erro fatal no teste de consolidação AutonomIA:', err)
    process.exitCode = 1
  })
