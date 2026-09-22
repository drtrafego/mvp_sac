// Teste de src/lib/google-calendar-sync.ts (sync de agenda_blocked_dates com
// o Google Calendar real do Dr. Lucas, 22/09/2026) e da rota
// GET /api/v1/companies/[idOrSlug]/agenda/sync que a expõe.
//
// Mesmo padrão de scripts/hermes-conversion-webhook.test.ts: sobe um
// Postgres DESCARTÁVEL de verdade via Docker, aplica o schema real do
// projeto (drizzle-kit push, já inclui as colunas novas de
// agenda_blocked_dates) e substitui só duas peças por mock
// (node:test mock.module, precisa da flag --experimental-test-module-mocks):
//   - '@/lib/db': vira uma instância real de drizzle-orm/postgres-js
//     apontando pro Postgres descartável.
//   - 'googleapis': google.calendar(...).events.list() vira um espião
//     controlado pelo teste (não chama a API do Google de verdade); os
//     eventos "de dia inteiro" retornados são os que cada cenário monta.
// google-auth-library/googleapis 'JWT' não precisa de mock: nunca faz uma
// chamada de rede sozinha, só guarda credenciais até ser usada pelo
// calendar() mockado acima.
//
// Casos cobertos (pedidos na tarefa):
//   (a) evento novo do Calendar cria linha source='google_calendar'
//   (b) evento do Calendar NÃO sobrescreve linha já source='manual'
//   (c) linha existente 'bot_bloqueios' + evento novo do Calendar vira
//       'google_calendar+bot_bloqueios' com reason concatenado
//   (d) rota funciona (não quebra) sem as env vars da Service Account
// Mais 2 casos de robustez/isolamento que a própria tarefa pede reconferir:
//   (e) empresa que não é o Dr. Lucas nunca sincroniza (guard explícito)
//   (f) rodar a sync duas vezes seguidas pro mesmo evento não duplica linha
//       (índice único company_id+date respeitado pelo upsert)
//
// Casos do FIX de bug de produção (ALTO, 22/09/2026): o calendário principal
// nunca foi compartilhado com a Service Account (404) e o iClinic é o único
// que funciona de verdade. Antes, Promise.all derrubava a sync inteira mesmo
// com o iClinic 100% acessível:
//   (j) principal falha (404) e iClinic funciona: eventos do iClinic são
//       gravados normalmente, e `calendars` no resultado mostra qual
//       calendário falhou e qual funcionou (sucesso parcial)
//   (k) os DOIS calendários falham: retorna erro geral google_api_error,
//       sem gravar nada incorreto
// Casos do fix de QA (bug ALTO, 22/09/2026, reason virou botReason +
// googleReason calculado em vez de string concatenada irreversível) e da 2ª
// rodada (bug ALTO reaberto: Hermes concatenava e o fallback de herança
// duplicava o motivo do Google e travava botReason pra sempre):
//   (g) 2ª e 3ª sync consecutiva do MESMO evento do Google não apaga mais a
//       parte do bot no reason combinado, já no formato NOVO em que o Hermes
//       escreve direto em `bot_reason` (sem fallback de herança nenhum).
//   (h) bot_reason atualizado pelo Hermes (simulado por escrita direta no
//       banco, como o cron faz de verdade) É REFLETIDO na sync seguinte do
//       Google — é o teste que provava a trava permanente do bug antigo.
//   (i) linha antiga (de antes deste fix) com source já combinado e
//       botReason ainda null: sync não duplica nem quebra, só documenta a
//       lacuna transitória aceitável (botReason fica null até o próximo
//       bloqueio real do Hermes, nunca mostra dado errado).
//
// Uso: npx tsx --experimental-test-module-mocks --test scripts/agenda-google-calendar-sync.test.ts

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, and } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { NextRequest } from 'next/server'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'agenda_google_calendar_sync_test'

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
  spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
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
      spawnSync('docker', ['rm', '-f', CONTAINER_NAME], { stdio: 'ignore' })
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

interface FakeAllDayEvent {
  id: string
  summary: string
  date: string
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

  const [drLucas] = await testDb
    .insert(schema.companies)
    .values({ name: 'Dr. Lucas (teste)', slug: 'drlucas' })
    .returning()

  const [outraEmpresa] = await testDb
    .insert(schema.companies)
    .values({ name: 'Outra Empresa (teste)', slug: 'outra-empresa-teste' })
    .returning()

  // calendarId -> lista de eventos de dia inteiro que o mock de
  // googleapis.events.list() devolve pra ele. Cada teste ajusta antes de rodar.
  let eventsByCalendar: Record<string, FakeAllDayEvent[]> = {}
  // calendarId -> mensagem de erro que o mock de events.list() deve lançar
  // pra simular o 404 real (calendário nunca compartilhado com a Service
  // Account). Usado pelos casos (j) e (k) de sucesso/falha parcial. Reseta
  // sozinho a cada setCalendarEvents pra nenhum teste vazar erro simulado
  // pro próximo.
  let errorByCalendar: Record<string, string> = {}
  function setCalendarEvents(map: Record<string, FakeAllDayEvent[]>) {
    eventsByCalendar = map
    errorByCalendar = {}
  }
  function setCalendarErrors(map: Record<string, string>) {
    errorByCalendar = map
  }

  mock.module('@/lib/db', {
    namedExports: { db: testDb },
  })

  // authenticateAgentRequest (usada pela rota /agenda/sync) importa
  // src/lib/auth.ts, que começa com `import 'server-only'` — pacote que só
  // existe dentro do runtime real do Next.js. Mesmo mock de
  // scripts/agent-auth-key-bypass.test.ts: todo teste aqui manda API key
  // (master key via SAC_API_KEY), então o caminho de sessão de navegador
  // nunca é exercitado, só precisa existir pro import não quebrar.
  mock.module('@/lib/auth', {
    namedExports: {
      getCurrentUser: async () => null,
      getCurrentCompany: async () => null,
    },
  })

  mock.module('googleapis', {
    namedExports: {
      google: {
        auth: {
          // Só guarda as credenciais recebidas; nunca faz chamada de rede
          // sozinha. Quem "responde" é o calendar() mockado abaixo.
          JWT: class FakeJWT {
            email: string
            key: string
            scopes: string[]
            constructor(opts: { email: string; key: string; scopes: string[] }) {
              this.email = opts.email
              this.key = opts.key
              this.scopes = opts.scopes
            }
          },
        },
        calendar: (_opts: unknown) => ({
          events: {
            list: async ({ calendarId }: { calendarId: string }) => {
              const errorMessage = errorByCalendar[calendarId]
              if (errorMessage) throw new Error(errorMessage)
              const items = (eventsByCalendar[calendarId] ?? []).map(ev => ({
                id: ev.id,
                summary: ev.summary,
                start: { date: ev.date },
              }))
              return { data: { items, nextPageToken: undefined } }
            },
          },
        }),
      },
    },
  })

  const PRIMARY_CALENDAR = 'drlucasfernandesdermato@gmail.com'
  const ICLINIC_CALENDAR =
    'c1be5614432cc356e375f91f01c5515f95be5d1bcfa3d7b7218882a68215e510@group.calendar.google.com'

  async function blockedRow(companyId: number, date: string) {
    const [row] = await testDb
      .select()
      .from(schema.agendaBlockedDates)
      .where(and(eq(schema.agendaBlockedDates.companyId, companyId), eq(schema.agendaBlockedDates.date, date)))
    return row
  }

  try {
    // Imports dinâmicos DENTRO do try: se um deles lançar (ex.: módulo que
    // precisa de mock a mais), o finally ainda derruba o Postgres descartável
    // e o container Docker em vez de deixar o processo pendurado.
    const { syncGoogleCalendarBlockedDates } = await import('../src/lib/google-calendar-sync')
    const { GET: syncRouteGET } = await import('../src/app/api/v1/companies/[idOrSlug]/agenda/sync/route')

    // ── (a) evento novo do Calendar cria linha source='google_calendar' ──
    await test('evento novo do Calendar cria linha source=google_calendar', async () => {
      process.env.GOOGLE_SA_CLIENT_EMAIL = 'sa@teste.iam.gserviceaccount.com'
      process.env.GOOGLE_SA_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----\\n'

      setCalendarEvents({
        [PRIMARY_CALENDAR]: [{ id: 'ev-consulta-1', summary: 'Consulta particular', date: '2026-10-05' }],
        [ICLINIC_CALENDAR]: [],
      })

      const result = await syncGoogleCalendarBlockedDates({ id: drLucas.id, slug: drLucas.slug })
      assert.equal(result.ok, true)
      assert.equal(result.skipped, false)
      assert.equal(result.created, 1)

      const row = await blockedRow(drLucas.id, '2026-10-05')
      assert.ok(row, 'deveria ter criado a linha')
      assert.equal(row.source, 'google_calendar')
      assert.equal(row.reason, 'Consulta particular')
      assert.equal(row.externalRef, 'ev-consulta-1')
      assert.ok(row.syncedAt, 'syncedAt deveria estar preenchido')
    })

    // ── (f) rodar de novo o MESMO evento não duplica, só atualiza ────────
    await test('rodar a sync de novo pro mesmo evento não duplica a linha (índice único respeitado)', async () => {
      const antes = await testDb
        .select()
        .from(schema.agendaBlockedDates)
        .where(and(eq(schema.agendaBlockedDates.companyId, drLucas.id), eq(schema.agendaBlockedDates.date, '2026-10-05')))
      assert.equal(antes.length, 1)

      const result = await syncGoogleCalendarBlockedDates({ id: drLucas.id, slug: drLucas.slug })
      assert.equal(result.ok, true)
      assert.equal(result.created, 0)
      assert.equal(result.updated, 1)

      const depois = await testDb
        .select()
        .from(schema.agendaBlockedDates)
        .where(and(eq(schema.agendaBlockedDates.companyId, drLucas.id), eq(schema.agendaBlockedDates.date, '2026-10-05')))
      assert.equal(depois.length, 1, 'não deveria duplicar a linha da mesma data')
    })

    // ── (b) evento do Calendar NÃO sobrescreve linha já source='manual' ──
    await test('evento do Calendar não sobrescreve linha já bloqueada manualmente', async () => {
      await testDb.insert(schema.agendaBlockedDates).values({
        companyId: drLucas.id,
        date: '2026-10-06',
        reason: 'Férias',
        source: 'manual',
      })

      setCalendarEvents({
        [PRIMARY_CALENDAR]: [{ id: 'ev-viagem-1', summary: 'Viagem', date: '2026-10-06' }],
        [ICLINIC_CALENDAR]: [],
      })

      const result = await syncGoogleCalendarBlockedDates({ id: drLucas.id, slug: drLucas.slug })
      assert.equal(result.ok, true)
      assert.ok((result.skippedManual ?? 0) >= 1)

      const row = await blockedRow(drLucas.id, '2026-10-06')
      assert.equal(row.source, 'manual')
      assert.equal(row.reason, 'Férias')
      assert.equal(row.externalRef, null)
      assert.equal(row.syncedAt, null)
    })

    // ── (c) 'bot_bloqueios' + evento novo do Calendar -> valor combinado ──
    await test("linha 'bot_bloqueios' existente + evento novo do Calendar vira 'google_calendar+bot_bloqueios' com reason concatenado", async () => {
      await testDb.insert(schema.agendaBlockedDates).values({
        companyId: drLucas.id,
        date: '2026-10-07',
        reason: 'Bloqueio bot',
        botReason: 'Bloqueio bot', // formato NOVO: Hermes escreve bot_reason direto (ver sync_bloqueios_sac.py)
        source: 'bot_bloqueios',
      })

      setCalendarEvents({
        [PRIMARY_CALENDAR]: [{ id: 'ev-congresso-1', summary: 'Congresso', date: '2026-10-07' }],
        [ICLINIC_CALENDAR]: [],
      })

      const result = await syncGoogleCalendarBlockedDates({ id: drLucas.id, slug: drLucas.slug })
      assert.equal(result.ok, true)
      assert.equal(result.updated, 1)

      const row = await blockedRow(drLucas.id, '2026-10-07')
      assert.equal(row.source, 'google_calendar+bot_bloqueios')
      assert.equal(row.reason, 'Bloqueio bot; Congresso')
      assert.equal(row.externalRef, 'ev-congresso-1')
      assert.ok(row.syncedAt)
    })

    // ── (g) FIX bug ALTO do QA (2ª rodada): 2ª e 3ª sync do MESMO evento não
    // apagam mais a parte do bot no reason combinado. Simula o cenário exato
    // que o QA reproduziu com a SQL do script Hermes já corrigido: "1ª sync"
    // é o Hermes gravando um bloqueio de bot direto em `bot_reason` (formato
    // NOVO, sync_bloqueios_sac.py pós-fix — ver upsert_uma_data), sem fallback
    // de herança nenhum envolvido. "2ª sync" e "3ª sync" são duas rodadas de
    // syncGoogleCalendarBlockedDates para a MESMA data com o MESMO evento do
    // Google ainda lá (nada mudou do lado do bot entre elas).
    await test('bug ALTO do QA (2ª rodada): reason mantém as duas partes na 2ª E na 3ª sync consecutiva, lendo bot_reason direto (sem fallback)', async () => {
      // "1ª sync": bloqueio do bot já gravado no formato NOVO (bot_reason
      // preenchido pelo Hermes, reason é só o espelho best-effort dele).
      await testDb.insert(schema.agendaBlockedDates).values({
        companyId: drLucas.id,
        date: '2026-10-09',
        reason: 'Bloqueio bot',
        botReason: 'Bloqueio bot',
        source: 'bot_bloqueios',
      })

      setCalendarEvents({
        [PRIMARY_CALENDAR]: [{ id: 'ev-congresso-2', summary: 'Congresso', date: '2026-10-09' }],
        [ICLINIC_CALENDAR]: [],
      })

      // "2ª sync"
      const result2 = await syncGoogleCalendarBlockedDates({ id: drLucas.id, slug: drLucas.slug })
      assert.equal(result2.ok, true)
      assert.equal(result2.updated, 1)

      const row2 = await blockedRow(drLucas.id, '2026-10-09')
      assert.equal(row2.source, 'google_calendar+bot_bloqueios')
      assert.equal(row2.reason, 'Bloqueio bot; Congresso')
      assert.equal(row2.botReason, 'Bloqueio bot')
      assert.equal(row2.googleReason, 'Congresso')

      // "3ª sync": mesmo evento do Google, nada mudou do lado do bot. Antes do
      // fix (1ª rodada), esta rodada sobrescrevia reason só com 'Congresso' e
      // perdia 'Bloqueio bot' mesmo o source continuando combinado.
      const result3 = await syncGoogleCalendarBlockedDates({ id: drLucas.id, slug: drLucas.slug })
      assert.equal(result3.ok, true)
      assert.equal(result3.updated, 1)

      const row3 = await blockedRow(drLucas.id, '2026-10-09')
      assert.equal(row3.source, 'google_calendar+bot_bloqueios')
      assert.equal(row3.reason, 'Bloqueio bot; Congresso', 'reason não pode perder a parte do bot na 3ª sync')
      assert.equal(row3.botReason, 'Bloqueio bot')
      assert.equal(row3.googleReason, 'Congresso')
    })

    // ── (h) FIX da trava permanente: bot_reason atualizado pelo Hermes é
    // refletido na sync seguinte do Google. Antes da 2ª rodada do fix, uma
    // vez que botReason deixava de ser null (herdado pelo fallback), a sync
    // nunca mais relia `reason`, então uma atualização real do bot (ex.:
    // paciente cancela e reagenda com motivo diferente) nunca aparecia. Como
    // agora botReason é sempre lido fresco de `existing.botReason` a cada
    // sync, uma escrita direta do Hermes (fora da sync) tem que aparecer na
    // rodada seguinte.
    await test('bot_reason atualizado pelo Hermes (motivo B) aparece na sync seguinte do Google, sem travar no motivo antigo', async () => {
      await testDb.insert(schema.agendaBlockedDates).values({
        companyId: drLucas.id,
        date: '2026-10-10',
        reason: 'Bloqueio bot: motivo A',
        botReason: 'Bloqueio bot: motivo A',
        googleReason: 'Congresso',
        source: 'google_calendar+bot_bloqueios',
        externalRef: 'ev-congresso-3',
        syncedAt: new Date(),
      })

      // Hermes atualiza o motivo direto no banco (é o que sync_bloqueios_sac.py
      // faz de verdade quando o paciente reagenda com outro motivo), sem
      // passar pela sync do Google.
      await testDb
        .update(schema.agendaBlockedDates)
        .set({ botReason: 'Bloqueio bot: motivo B', reason: 'Bloqueio bot: motivo B' })
        .where(and(eq(schema.agendaBlockedDates.companyId, drLucas.id), eq(schema.agendaBlockedDates.date, '2026-10-10')))

      setCalendarEvents({
        [PRIMARY_CALENDAR]: [{ id: 'ev-congresso-3', summary: 'Congresso', date: '2026-10-10' }],
        [ICLINIC_CALENDAR]: [],
      })

      const result = await syncGoogleCalendarBlockedDates({ id: drLucas.id, slug: drLucas.slug })
      assert.equal(result.ok, true)
      assert.equal(result.updated, 1)

      const row = await blockedRow(drLucas.id, '2026-10-10')
      assert.equal(row.source, 'google_calendar+bot_bloqueios')
      assert.equal(row.botReason, 'Bloqueio bot: motivo B')
      assert.equal(row.reason, 'Bloqueio bot: motivo B; Congresso', 'reason tem que refletir o motivo B, nunca travar no motivo A')
      assert.equal(row.googleReason, 'Congresso')
    })

    // ── (i) Lacuna transitória ACEITÁVEL (item 3 da tarefa): linha de antes
    // deste fix, com source já combinado mas botReason ainda null porque o
    // Hermes ainda não rodou de novo pra essa data depois do deploy. A sync
    // não pode duplicar nem inventar texto: sem fallback de herança, botReason
    // continua null e reason mostra só o texto do Google, até o próximo
    // bloqueio real do Hermes preencher bot_reason.
    await test('linha antiga com source combinado e botReason null: sync não duplica nem inventa dado, só documenta a lacuna até o Hermes rodar de novo', async () => {
      await testDb.insert(schema.agendaBlockedDates).values({
        companyId: drLucas.id,
        date: '2026-10-11',
        reason: 'Bloqueio bot + Congresso', // texto legado, concatenado pelo Hermes antigo
        botReason: null,
        source: 'google_calendar+bot_bloqueios',
      })

      setCalendarEvents({
        [PRIMARY_CALENDAR]: [{ id: 'ev-congresso-4', summary: 'Congresso', date: '2026-10-11' }],
        [ICLINIC_CALENDAR]: [],
      })

      const result = await syncGoogleCalendarBlockedDates({ id: drLucas.id, slug: drLucas.slug })
      assert.equal(result.ok, true)
      assert.equal(result.updated, 1)

      const row = await blockedRow(drLucas.id, '2026-10-11')
      assert.equal(row.source, 'google_calendar+bot_bloqueios', 'source combinado é preservado')
      assert.equal(row.botReason, null, 'sem fallback, botReason fica null até o Hermes escrever de novo (lacuna aceitável, não é bug)')
      assert.equal(row.googleReason, 'Congresso')
      assert.equal(row.reason, 'Congresso', 'reason nunca duplica nem inventa o texto antigo do bot')
    })

    // ── (j) FIX bug de produção (ALTO, 22/09/2026): principal falha (404,
    // nunca compartilhado com a Service Account) e iClinic funciona. Antes,
    // Promise.all derrubava a sync inteira mesmo com o iClinic 100%
    // acessível. Agora o evento do iClinic tem que ser gravado normalmente,
    // e o resultado tem que reportar qual calendário falhou e qual funcionou.
    await test('sucesso parcial: calendário principal falha (404) mas iClinic funciona, eventos do iClinic são gravados e o resultado reporta os dois status', async () => {
      setCalendarEvents({
        [PRIMARY_CALENDAR]: [],
        [ICLINIC_CALENDAR]: [{ id: 'ev-iclinic-1', summary: 'Bloqueio iClinic', date: '2026-10-20' }],
      })
      setCalendarErrors({
        [PRIMARY_CALENDAR]: 'Not Found',
      })

      const result = await syncGoogleCalendarBlockedDates({ id: drLucas.id, slug: drLucas.slug })
      assert.equal(result.ok, true, 'sucesso parcial ainda é ok:true, um calendário funcionando basta')
      assert.equal(result.skipped, false)
      assert.equal(result.created, 1)
      assert.equal(result.eventsFound, 1, 'só conta o evento do calendário que funcionou')

      const row = await blockedRow(drLucas.id, '2026-10-20')
      assert.ok(row, 'evento do iClinic (calendário que funciona) tem que ser gravado mesmo com o principal falhando')
      assert.equal(row.source, 'google_calendar')
      assert.equal(row.reason, 'Bloqueio iClinic')

      assert.ok(Array.isArray(result.calendars), 'resultado tem que reportar o status de cada calendário')
      const primaryStatus = result.calendars!.find(c => c.id === PRIMARY_CALENDAR)
      const iclinicStatus = result.calendars!.find(c => c.id === ICLINIC_CALENDAR)
      assert.equal(primaryStatus?.ok, false)
      assert.equal(primaryStatus?.error, 'Not Found')
      assert.equal(iclinicStatus?.ok, true)
      assert.equal(iclinicStatus?.eventsFound, 1)
    })

    // ── (k) os DOIS calendários falham: erro geral, nada gravado ──────────
    await test('os dois calendários falham (404 nos dois): retorna erro geral google_api_error, sem gravar nada', async () => {
      setCalendarEvents({
        [PRIMARY_CALENDAR]: [],
        [ICLINIC_CALENDAR]: [],
      })
      setCalendarErrors({
        [PRIMARY_CALENDAR]: 'Not Found',
        [ICLINIC_CALENDAR]: 'Not Found',
      })

      const result = await syncGoogleCalendarBlockedDates({ id: drLucas.id, slug: drLucas.slug })
      assert.equal(result.ok, false)
      assert.equal(result.skipped, false)
      assert.equal(result.reason, 'google_api_error')
      assert.ok(result.errorMessage?.includes('Not Found'))
      assert.equal(result.created, undefined, 'não deve processar upsert nenhum quando os dois falham')

      assert.ok(Array.isArray(result.calendars))
      assert.ok(result.calendars!.every(c => c.ok === false))
    })

    // ── (e) empresa que não é o Dr. Lucas nunca sincroniza ───────────────
    await test('empresa que não é o Dr. Lucas: guard explícito, nunca chama o Google nem grava nada', async () => {
      setCalendarEvents({
        [PRIMARY_CALENDAR]: [{ id: 'ev-nao-deveria-existir', summary: 'Não deveria entrar', date: '2026-10-08' }],
        [ICLINIC_CALENDAR]: [],
      })

      const result = await syncGoogleCalendarBlockedDates({ id: outraEmpresa.id, slug: outraEmpresa.slug })
      assert.equal(result.ok, true)
      assert.equal(result.skipped, true)
      assert.equal(result.reason, 'not_drlucas')

      const row = await blockedRow(outraEmpresa.id, '2026-10-08')
      assert.equal(row, undefined, 'não deveria ter criado nada pra outra empresa')
    })

    // ── (d) rota funciona sem as env vars da Service Account ─────────────
    await test('GET /agenda/sync sem env vars da Service Account -> 200, ok:true, skipped, não quebra', async () => {
      const emailAntes = process.env.GOOGLE_SA_CLIENT_EMAIL
      const keyAntes = process.env.GOOGLE_SA_PRIVATE_KEY
      delete process.env.GOOGLE_SA_CLIENT_EMAIL
      delete process.env.GOOGLE_SA_PRIVATE_KEY

      try {
        const masterKey = process.env.SAC_API_KEY ?? 'test-master-key-agenda-sync'
        process.env.SAC_API_KEY = masterKey

        const req = new NextRequest(
          `https://sac.example.com/api/v1/companies/drlucas/agenda/sync?backfill=0`,
          { headers: { authorization: `Bearer ${masterKey}` } },
        )
        const res = await syncRouteGET(req, { params: Promise.resolve({ idOrSlug: 'drlucas' }) })
        assert.equal(res.status, 200)
        const json = await res.json()
        assert.equal(json.ok, true)
        assert.equal(json.skipped, true)
        assert.equal(json.reason, 'google_sync_not_configured')
      } finally {
        if (emailAntes !== undefined) process.env.GOOGLE_SA_CLIENT_EMAIL = emailAntes
        if (keyAntes !== undefined) process.env.GOOGLE_SA_PRIVATE_KEY = keyAntes
      }
    })

  } finally {
    await sql.end({ timeout: 2 })
    disposable.stop()
  }
}

main()
  .then(() => {
    if (!process.exitCode) {
      console.log('\nOK: sync do Google Calendar do Dr. Lucas rodou contra Postgres descartável real.')
    }
  })
  .catch(err => {
    console.error('Erro fatal no teste de sync do Google Calendar:', err)
    process.exitCode = 1
  })
