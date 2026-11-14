/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
// Teste de integração do Operador SAC. Sobe Postgres descartável real, aplica
// o schema real e troca somente '@/lib/db' pela conexão do teste.
//
// Uso (fora do sandbox):
// node --require ./scripts/operator-server-only-register.cjs --experimental-test-module-mocks --import tsx --test scripts/operator-fase0-integration.test.ts

import { test, mock } from 'node:test'
import { register } from 'node:module'
import Module from 'node:module'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import postgres from 'postgres'
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http"
import { readFileSync } from "node:fs"
import { drizzle } from 'drizzle-orm/postgres-js'
import { and, count, eq, isNull } from 'drizzle-orm'
import * as schema from '../src/lib/db/schema'
import { NextRequest } from 'next/server'

const PROJECT_ROOT = path.resolve(__dirname, '..')
const CONTAINER_NAME = 'operator_fase0_integration_test'

// O pacote é resolvido pelo Next no app, mas não existe no runner cru do Node.
// O loader é restrito a este harness e não altera package.json nem node_modules.
register('./operator-server-only-loader.mjs', import.meta.url)
const moduleResolver = Module as typeof Module & { _resolveFilename: (...args: any[]) => string }
const originalResolveFilename = moduleResolver._resolveFilename
moduleResolver._resolveFilename = (request: string, parent: unknown, isMain: boolean, options: unknown) => request === 'server-only'
  ? path.join(PROJECT_ROOT, 'scripts/operator-server-only-stub.cjs')
  : originalResolveFilename.call(Module, request, parent, isMain, options)

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

  const MIG = readFileSync(path.join(PROJECT_ROOT, 'drizzle/0044_sac_operator.sql'), 'utf8')
  const pgn = postgres(disposable.url, { max: 30, types: {
    ts: { to: 1114, from: [1082, 1114, 1184], serialize: (x: any) => x, parse: (x: any) => x },
    jsonb: { to: 3802, from: [3802, 114], serialize: (x: any) => x, parse: (x: any) => x },
  } as any })
  const fakeNeon: any = async (text: string, params: unknown[] = [], opts: any = {}) => {
    const q = pgn.unsafe(text, (params as any[]).map(p => p instanceof Date ? p.toISOString() : p))
    const rows: any[] = opts.arrayMode ? await q.values() : await q
    return { rows, rowCount: rows.length, command: 'X', fields: [], rowAsArray: !!opts.arrayMode }
  }
  fakeNeon.query = fakeNeon
  fakeNeon.transaction = async () => { throw new Error('No transactions support in neon-http driver') }
  const neonDb = drizzleNeon(fakeNeon, { schema })
  const out = (k: string, v: unknown) => console.log(`QA> ${k} :: ${JSON.stringify(v)}`)
  const snap = async () => {
    const r = await sql`
      select 'col' k, table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'')||':'||ordinal_position::text v from information_schema.columns where table_schema='public' and table_name not like 'sac_operator%'
      union all select 'idx', tablename||'|'||indexdef from pg_indexes where schemaname='public' and tablename not like 'sac_operator%'
      union all select 'con', conrelid::regclass::text||'|'||conname||'|'||pg_get_constraintdef(oid) from pg_constraint where connamespace='public'::regnamespace and conrelid::regclass::text not like 'sac_operator%'
      union all select 'trg', tgrelid::regclass::text||'|'||tgname from pg_trigger where not tgisinternal
      union all select 'tbl', relname||':'||relkind::text from pg_class where relnamespace='public'::regnamespace and relname not like 'sac_operator%' and relname not like '%_seq'
      order by 1,2`
    return r.map((x: any) => `${x.k}|${x.v}`)
  }
  const cdp = async () => (await sql`select 'cdp:'||string_agg(table_name,',' order by table_name) v from information_schema.tables where table_schema='public' and table_name like 'sac_operator%'`)[0].v
  const state = async () => JSON.stringify({
    pause: await sql`select * from company_pause_switches order by id`,
    leads: await sql`select id,company_id,bot_paused,pipeline_stage,name from recovery_leads where phone not like 'ig_b%' and phone <> 'ig_last' order by id`,
    rules: await sql`select id,company_id,is_active,keywords,dm_message,trigger_type from instagram_comment_automations order by id`,
    msgs: await sql`select count(*)::int c from whatsapp_messages`,
  })

  process.env.OPENROUTER_API_KEY = 'sk-or-QAKEY-SEGREDO-123'
  const logs: string[] = []
  for (const m of ['log', 'error', 'warn', 'info'] as const) { const o = (console as any)[m].bind(console); (console as any)[m] = (...a: any[]) => { const s = a.map(x => x instanceof Error ? x.stack || x.message : typeof x === 'string' ? x : JSON.stringify(x)).join(' '); if (!s.startsWith('QA>')) logs.push(s); o(...a) } }
  try {
    const [coA, coB] = await testDb.insert(schema.companies).values([{ name: 'Empresa A', slug: 'a' }, { name: 'Empresa B', slug: 'b' }]).returning()
    const mkLead = (companyId: number, name: string, phone: string, extra: any = {}) => ({ companyId, phone, name, email: null, platform: 'instagram', eventType: 'comment_to_dm', status: 'in_conversation', pipelineStage: 'novo', ...extra }) as any
    await testDb.insert(schema.recoveryLeads).values([
      mkLead(coA.id, 'Maria Souza', '5511999998888', { email: 'maria@acme.com' }), mkLead(coA.id, 'João da Silva', '5511977776666'), mkLead(coA.id, 'Zé do Caminhão', '5511966665555'),
      mkLead(coA.id, 'Luana Pereira de Souza', '5511955554444'), mkLead(coA.id, 'Instagram (1234)', 'ig_1'), mkLead(coA.id, 'Reel do Instagram e Automação', 'ig_2'),
      mkLead(coB.id, 'Fernanda Borges', '5521988887777'), mkLead(coB.id, 'Maria Outra Empresa', '5521988880000'),
    ])
    await testDb.insert(schema.instagramCommentAutomations).values([{ companyId: coA.id, name: 'ra', keywords: 'abc', dmMessage: 'x' }, { companyId: coB.id, name: 'rb', keywords: 'zzz', dmMessage: 'x' }] as any)
    await testDb.insert(schema.companyPauseSwitches).values({ companyId: coA.id, scope: 'all', active: true } as any)

    let cookieNames = new Set<string>()
    let authMode: 'admin' | 'member' | 'none' | 'unauth' = 'admin'
    let authCompany = coA; let userId = 'u0'; const newUser = () => { userId = 'u' + Math.random().toString(36).slice(2) }
    class ForbiddenError extends Error { readonly status = 403; constructor(m = 'Acesso negado: requer administrador da empresa') { super(m); this.name = 'ForbiddenError' } }
    class AuthError extends Error { readonly status = 401; constructor(m: string) { super(m); this.name = 'AuthError' } }
    mock.module('server-only', { namedExports: {} })
    mock.module('next/headers', { namedExports: { cookies: async () => ({ has: (n: string) => cookieNames.has(n), get: (n: string) => cookieNames.has(n) ? { value: 'x' } : undefined }) } })
    mock.module('@/lib/auth', { namedExports: {
      AuthError, ForbiddenError,
      requireCompanyRole: async () => {
        if (authMode === 'none') { const e: any = new Error('NEXT_REDIRECT'); e.digest = 'NEXT_REDIRECT;replace;/handler/sign-in;307;'; throw e }
        if (authMode === 'unauth') throw new AuthError('Não autenticado')
        if (authMode === 'member') throw new ForbiddenError()
        return { company: authCompany, user: { id: userId, displayName: 'Admin', primaryEmail: 'a@a.com' }, role: 'admin', memberId: 1 }
      },
      getCurrentUser: async () => null, getCurrentCompany: async () => null,
    } })
    mock.module('@/lib/db', { namedExports: { db: neonDb } })
    let orMode = 'ok'; let orPlan: any = { actions: [{ type: 'listar_etapas' }], response: 'ok' }; const orBodies: any[] = []
    mock.method(globalThis, 'fetch', async (url: any, init: any) => {
      if (!String(url).startsWith('https://openrouter.ai/')) throw new Error('rede proibida: ' + url)
      orBodies.push(JSON.parse(init.body))
      if (orMode === 'timeout') { await new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }
      if (orMode === '429') return new Response('{"error":{"message":"rate limited sk-or-QAKEY-SEGREDO-123"}}', { status: 429 })
      if (orMode === '500') return new Response('boom', { status: 500 })
      if (orMode === 'badjson') return new Response(JSON.stringify({ choices: [{ message: { content: '{nao e json' } }] }), { status: 200 })
      if (orMode === 'slow') await new Promise(r => setTimeout(r, 300))
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(typeof orPlan === 'function' ? orPlan(init) : orPlan) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 })
    })
    const msgs = await import('../src/app/api/operator/messages/route')
    const jobsR = await import('../src/app/api/operator/jobs/[jobId]/route')
    const page = await import('../src/app/(dashboard)/operar/page')
    const { NextRequest } = await import('next/server')
    const postReq = (b: unknown, origin = 'https://sac.test') => new NextRequest('https://sac.test/api/operator/messages', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(b) })
    const postReqWithoutOrigin = (b: unknown) => new NextRequest('https://sac.test/api/operator/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    const P = async (b: unknown) => { const r = await msgs.POST(postReq(b)); let j: any = null; try { j = await r.json() } catch {} return { s: r.status, j } }
    const PWithoutOrigin = async (b: unknown) => { const r = await msgs.POST(postReqWithoutOrigin(b)); let j: any = null; try { j = await r.json() } catch {} return { s: r.status, j } }
    const G = async () => { const r = await msgs.GET(); let j: any = null; try { j = await r.json() } catch {} return { s: r.status, j } }
    const GJ = async (id: string) => { const r = await jobsR.GET(new Request('https://x'), { params: Promise.resolve({ jobId: id }) }); let j: any = null; try { j = await r.json() } catch {} return { s: r.status, j } }
    const pageTry = async () => { try { const el: any = await page.default(); const d = el?.props?.children; const desc = Array.isArray(d) ? d[0]?.props?.description : d?.props?.description; return 'RENDER:' + String(desc).slice(0, 90) } catch (e: any) { return 'THROWS:' + e.constructor.name + ':' + String(e.message).slice(0, 60) } }
    const before = await snap(); const stBefore = await state()
    const noSql = (x: any) => !/select |params|Failed query|sac_operator|NEXT_REDIRECT/i.test(JSON.stringify(x))
    const FAKE = '00000000-0000-4000-8000-000000000001'

    await test('1 TABELAS AUSENTES', async () => {
      out('1 tabelas', await cdp()); const g = await G(), p = await P({ text: 'listar etapas' }), j = await GJ(FAKE)
      out('1 GET/POST/GETjob', [g, p, j].map(r => [r.s, r.j?.error])); out('1 sem SQL/params/NEXT_REDIRECT nos corpos', [g, p, j].every(r => noSql(r.j))); out('1 pagina', await pageTry())
      assert.deepEqual([g.s, p.s, j.s], [403, 403, 403])
      assert.equal([g, p, j].every(result => noSql(result.j)), true)
      assert.match(await pageTry(), /Operador desligado para esta empresa\./)
    })
    const run = (args: string[], env: Record<string, string>) => spawnSync('npx', ['tsx', 'scripts/operator-apply-migration.ts', ...args], { cwd: PROJECT_ROOT, env: { ...process.env, ...env }, encoding: 'utf8' })
    await test('9 aplicador e aditividade', async () => {
      const dry = run([], {}); out('9 dry-run', [dry.status, await cdp()])
      out('9 sem CONFIRM', [run(['--apply'], { OPERATOR_MIGRATION_DATABASE_URL: disposable.url, OPERATOR_MIGRATION_EXPECTED_DATABASE: 'test' }).status, await cdp()])
      const ok = { OPERATOR_MIGRATION_CONFIRM: 'sim', OPERATOR_MIGRATION_DATABASE_URL: disposable.url, OPERATOR_MIGRATION_EXPECTED_DATABASE: 'test' }
      const a1 = run(['--apply'], ok); const mid = await snap(); const a2 = run(['--apply'], ok); const after = await snap()
      out('9 apply 1 e 2', [a1.status, a2.status]); out('9 tabelas novas', await cdp()); out('9 existentes iguais (#1,#2)', [JSON.stringify(before) === JSON.stringify(mid), JSON.stringify(before) === JSON.stringify(after), before.length])
      out('9 triggers/FK novas', [(await sql`select tgname from pg_trigger where not tgisinternal`).length, (await sql`select conname from pg_constraint where contype='f' and conrelid::regclass::text like 'sac_operator%'`).length])
      out('9 SQL proibido no .sql', MIG.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').match(/\b(ALTER|DROP|UPDATE|DELETE|INSERT|TRIGGER|REFERENCES|TRUNCATE)\b/gi))
      out('9 settings colunas', (await sql`select column_name||':'||data_type||':'||coalesce(column_default,'') v from information_schema.columns where table_name='sac_operator_company_settings' order by ordinal_position`).map((x: any) => x.v))
      assert.equal(dry.status, 0); assert.notEqual(run(['--apply'], { OPERATOR_MIGRATION_DATABASE_URL: disposable.url, OPERATOR_MIGRATION_EXPECTED_DATABASE: 'test' }).status, 0)
      assert.deepEqual([a1.status, a2.status], [0, 0])
      assert.equal(JSON.stringify(before) === JSON.stringify(mid) && JSON.stringify(before) === JSON.stringify(after), true)
      assert.equal((await sql`select count(*)::int c from information_schema.tables where table_schema='public' and table_name like 'sac_operator%'`)[0].c, 3)
    })
    const opSchema = await import('../src/lib/operator/schema')
    const seed = async (companyId: number, v: any = {}) => sql`insert into sac_operator_company_settings (company_id, enabled, kill_switch, max_jobs_per_day, daily_token_budget) values (${companyId}, ${v.enabled ?? false}, ${v.killSwitch ?? false}, ${v.maxJobsPerDay ?? 50}, ${v.dailyTokenBudget ?? 50000})
      on conflict (company_id) do update set enabled=excluded.enabled, kill_switch=excluded.kill_switch, max_jobs_per_day=excluded.max_jobs_per_day, daily_token_budget=excluded.daily_token_budget, daily_usage_date=null, daily_jobs_reserved=0, daily_tokens_reserved=0`
    const clearJobs = async () => { await sql`delete from sac_operator_jobs`; }

    await test('3/4 desligado, kill switch, pagina, codigos', async () => {
      await sql`delete from sac_operator_company_settings`; await sql`delete from sac_operator_jobs`; orBodies.length = 0
      out('3 sem linha', [(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s, await pageTry()])
      assert.deepEqual([(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s], [403, 403, 403])
      assert.match(await pageTry(), /Operador desligado para esta empresa\./u)
      await seed(coA.id, { enabled: false }); out('3 enabled=false', [(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s, await pageTry()])
      assert.deepEqual([(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s], [403, 403, 403])
      assert.match(await pageTry(), /Operador desligado para esta empresa\./u)
      await seed(coA.id, { enabled: true, killSwitch: true }); out('3 kill_switch', [(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s, await pageTry()])
      assert.deepEqual([(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s], [403, 403, 403])
      assert.match(await pageTry(), /Operador desligado para esta empresa\./u)
      out('3 jobs/chamadas modelo enquanto desligado', [(await sql`select count(*)::int c from sac_operator_jobs`)[0].c, orBodies.length])
      await seed(coA.id, { enabled: true }); await seed(coB.id, { enabled: true })
      out('3 habilitada pagina', await pageTry())
      assert.match(await pageTry(), /^RENDER:Operações da empresa Empresa A\. O operador move etapas, anota em leads e prepara regras do/u)
      authMode = 'member'; out('4 membro nao admin', [(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s, await pageTry()]); 
      assert.match(await pageTry(), /Sem permissão para usar o Operador SAC\./u)
      authMode = 'unauth'; out('4 AuthError', [(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s, await pageTry()])
      assert.deepEqual([(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s], [401, 401, 401])
      assert.match(await pageTry(), /Sem permissão para usar o Operador SAC\./u)
      authMode = 'none'; const rs = [await G(), await P({ text: 'x' }), await GJ(FAKE)]; out('4 sem sessao (redirect)', [rs.map(r => r.s), rs.every(r => noSql(r.j)), await pageTry()]); authMode = 'admin'
      assert.deepEqual(rs.map(result => result.s), [401, 401, 401]); assert.equal(rs.every(result => noSql(result.j)), true)
      cookieNames = new Set(['agent_auth_session']); out('4 cookie agente', [(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s, await pageTry()]); cookieNames = new Set()
      newUser(); authCompany = coB; const rb = await P({ text: 'listar etapas', idempotencyKey: 'b-1' }); authCompany = coA; const ra = await P({ text: 'listar etapas', idempotencyKey: 'a-1' })
      out('4 job de B por A / invalido / proprio', [(await GJ(rb.j.job.id)).s, (await GJ('nao-e-uuid')).s, (await GJ("'; drop table x;--")).s, (await GJ(ra.j.job.id)).s]); out('4 historico so A', (await G()).j.jobs.map((x: any) => x.companyId))
      const sp = await P({ text: 'listar etapas', idempotencyKey: 'sp', company_id: coB.id }); out('4 company_id extra rejeitado', sp.s)
      const semOrigin = await PWithoutOrigin({ text: 'listar etapas', idempotencyKey: 'sem-origin' }); out('4 POST sem Origin rejeitado', semOrigin.s)
      out('4 tamanhos', [(await P({ text: 'a'.repeat(4001) })).s, (await P({ text: ' ' })).s, (await P({ text: 5 })).s])
      assert.deepEqual([sp.s, semOrigin.s, (await P({ text: 'a'.repeat(4001) })).s, (await P({ text: ' ' })).s, (await P({ text: 5 })).s], [400, 403, 400, 400, 400])
      authMode = 'member'; assert.deepEqual([(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s], [403, 403, 403]); authMode = 'admin'
      cookieNames = new Set(['agent_auth_session']); assert.deepEqual([(await G()).s, (await P({ text: 'x' })).s, (await GJ(FAKE)).s], [401, 401, 401]); cookieNames = new Set()
      assert.deepEqual([(await GJ(rb.j.job.id)).s, (await GJ('nao-e-uuid')).s, (await GJ(ra.j.job.id)).s], [404, 404, 200])
    })
    const payloads = async (texts: string[], opts: { company?: any } = {}) => { newUser(); orBodies.length = 0; orPlan = { actions: [{ type: 'listar_etapas' }], response: 'ok' }; await clearJobs(); await seed(coA.id, { enabled: true, maxJobsPerDay: 1000, dailyTokenBudget: 100000000 }); for (let i = 0; i < texts.length; i++) { if (i % 15 === 14) newUser(); await P({ text: texts[i], idempotencyKey: 'pl-' + Math.random() }) } return orBodies.map(b => b.messages[1].content as string) }
    await test('2 PII no corpo real', async () => {
      const texts = ['Busque maria souza', 'busque a maria souza telefone +55 (11) 98765-4321', 'procure joao da silva', 'procure joão da silva', 'achar JOAO', 'ZÉ DO CAMINHÃO', 'zé do caminhão', 'ze do caminhao', 'Luana Pereira de Souza', 'luana pereira de souza', 'fale com Luana', 'sobrenome souza', 'SOUZA', 'Silva', 'a dona Maria', 'Mari', 'Maria S.', 'maria@acme.com e joao@x.com.br', '(11) 99999-8888 / 11999998888 / 5511999998888 / +55 11 9 9999 8888 / 11 9 9999-8888', 'CPF 123.456.789-09 e 12345678909', 'nome: Carlos Eduardo, cliente: Ana Paula', 'Busque Fernanda Borges', 'busque fernanda borges', 'Fernanda', 'fernanda', 'Zezinho do Pão', 'zezinho', 'Silvana Duarte Lima Santos Neto', 'Busque Dr. Roberto']
      const ps = await payloads(texts); texts.forEach((t, i) => out(`2 [${t}] =>`, ps[i].replace('Pedido já anonimizado pelo servidor: ', '')))
      const allText = ps.join('\n').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
      const leaked = ['maria souza', 'maria', 'joao', 'silva', 'souza', 'ze do', 'caminhao', 'luana', 'pereira', 'carlos', 'eduardo', 'ana paula', 'fernanda', 'borges', 'zezinho', 'silvana', 'roberto', 'duarte'].filter(n => allText.includes(n))
      out('2 NOMES QUE AINDA APARECEM NO CORPO ENVIADO', leaked)
      out('2 numeros/emails que aparecem', { email: /@/.test(allText), fone: /9999|98765|99999|7777/.test(allText), cpf: /123\.?456|12345678909/.test(allText) })
      assert.deepEqual(leaked, [], 'o corpo real do fetch não pode conter PII')
      assert.equal(/@|9999|98765|99999|7777|123\.?456|12345678909/.test(allText), false)
      const pl = await payloads(['Liste as regras do Instagram', 'Quais são as etapas do pipeline?', 'listar etapas da automação', 'lista de leads do Reel']); out('2 pedidos legitimos (dicionario com tokens comuns)', pl.map(x => x.replace('Pedido já anonimizado pelo servidor: ', '')))
      assert.equal(pl[0].includes('[T'), false, 'termos do produto e conectivos ficam em claro')
      out('2 corpo tem so model/max_tokens/response_format/messages', Object.keys(orBodies[0]))
    })
    await test('2b dicionario: escopo e limite', async () => {
      const ps = await payloads(['busque fernanda borges', 'busque maria outra empresa']); out('2b nomes da empresa B no payload de A (escopo)', ps.map(x => x.replace('Pedido já anonimizado pelo servidor: ', '')))
      // marcador resolvido no servidor devolve só A
      orPlan = { actions: [{ type: 'buscar_lead', query: '[T1]' }], response: 'x' }; newUser(); await clearJobs()
      const r = await P({ text: 'busque maria', idempotencyKey: 'mk1' }); out('2b busca via marcador (A tem Maria Souza; B tem Maria Outra Empresa)', [r.s, JSON.stringify(r.j?.job?.resultJson), r.j?.job?.requestText, JSON.stringify(r.j?.job?.planJson)])
      orPlan = { actions: [{ type: 'buscar_lead', query: '[PESSOA_9]' }], response: 'x' }; const r2 = await P({ text: 'busque maria', idempotencyKey: 'mk2' }); out('2b marcador inexistente', [r2.s, JSON.stringify(r2.j?.job?.resultJson)])
      orPlan = { actions: [{ type: 'buscar_lead', query: 'fernanda' }], response: 'x' }; const r3 = await P({ text: 'busque alguem', idempotencyKey: 'mk3' }); out('2b modelo adivinha nome da empresa B', [r3.s, JSON.stringify(r3.j?.job?.resultJson)])
      // limite de 2000 leads
      const bulk = Array.from({ length: 2100 }, (_, i) => mkLead(coA.id, `Pessoa${String(i).padStart(4, '0')} Sobrenome`, `ig_b${i}`))
      await testDb.insert(schema.recoveryLeads).values(bulk); await testDb.insert(schema.recoveryLeads).values(mkLead(coA.id, 'Zacarias Fontoura', 'ig_last'))
      const pb = await payloads(['busque zacarias fontoura', 'busque Zacarias', 'busque o fontoura']); out('2b lead alem do 2000o (empresa grande como 292/4)', pb.map(x => x.replace('Pedido já anonimizado pelo servidor: ', '')))
      assert.equal(pb.join(' ').toLowerCase().includes('zacarias') || pb.join(' ').toLowerCase().includes('fontoura'), false)
      const t0 = Date.now(); await payloads(['listar etapas']); out('2b custo da consulta do dicionario (ms, 2100+ leads)', Date.now() - t0)
      orPlan = { actions: [{ type: 'listar_etapas' }], response: 'ok' }
    })
    await test('5/6 falhas do provedor, chave, atomicidade e quota', async () => {
      await clearJobs(); await seed(coA.id, { enabled: true, maxJobsPerDay: 1000, dailyTokenBudget: 100000000 }); newUser()
      for (const m of ['429', '500', 'badjson', 'timeout']) { orMode = m; const t0 = Date.now(); const r = await P({ text: 'listar etapas', idempotencyKey: 'f-' + m }); out('5 falha ' + m, [r.s, r.j?.job?.status, r.j?.job?.errorCode, r.j?.job?.resultText, Date.now() - t0 > 9000 ? '~10s' : 'rapido']) }
      orMode = 'ok'; out('5 chave em log/banco', { logs: logs.some(l => l.includes('QAKEY')), banco: (await sql`select count(*)::int c from sac_operator_jobs where result_text ilike '%QAKEY%' or result_json::text ilike '%QAKEY%'`)[0].c })
      out('5 logs com PII', logs.filter(l => /maria|joão|silva|souza|fernanda/i.test(l)).slice(0, 3))
      const cnt = async () => (await sql`select daily_jobs_reserved j, daily_tokens_reserved t, daily_usage_date::text d from sac_operator_company_settings where company_id=${coA.id}`)[0]
      await clearJobs(); await seed(coA.id, { enabled: true, maxJobsPerDay: 3, dailyTokenBudget: 100000000 }); newUser()
      const r10 = await Promise.all(Array.from({ length: 10 }, (_, i) => P({ text: 'listar etapas', idempotencyKey: 'at-' + i })))
      out('6 max_jobs=3, 10 chaves simultaneas', { statuses: r10.map(r => r.s).sort(), aceitos: r10.filter(r => r.s === 202).length, jobs: (await sql`select count(*)::int c from sac_operator_jobs`)[0].c, contador: await cnt(), codigos: [...new Set(r10.filter(r => r.s === 429).map(r => r.j.code))] })
      assert.equal(r10.filter(r => r.s === 202).length, 3)
      let worst = 0; for (let round = 0; round < 10; round++) { await clearJobs(); await seed(coA.id, { enabled: true, maxJobsPerDay: 3, dailyTokenBudget: 100000000 }); newUser(); const rr = await Promise.all(Array.from({ length: 10 }, (_, i) => P({ text: 'x', idempotencyKey: `at${round}-${i}` }))); worst = Math.max(worst, rr.filter(r => r.s === 202).length) }
      out('6 pior caso em 10 rodadas (max_jobs=3)', worst)
      await clearJobs(); await seed(coA.id, { enabled: true, maxJobsPerDay: 1000, dailyTokenBudget: 5000 }); newUser()
      const rt = await Promise.all(Array.from({ length: 10 }, (_, i) => P({ text: 'x', idempotencyKey: 'tk-' + i }))); out('6 orcamento 5000 (reserva 2400), 10 simultaneas', { aceitos: rt.filter(r => r.s === 202).length, codigos: [...new Set(rt.filter(r => r.s === 429).map(r => r.j.code))], contador: await cnt(), tokensJobs: (await sql`select sum(tokens_in+tokens_out)::int s from sac_operator_jobs`)[0].s })
      const fin = (await sql`select status, tokens_in, tokens_out from sac_operator_jobs limit 1`)[0]; out('6 job concluido: tokens assentados (real 100+20, reserva 2400)', fin)
      await clearJobs(); await seed(coA.id, { enabled: true, maxJobsPerDay: 0, dailyTokenBudget: 100000 }); newUser(); const z = [await P({ text: 'x', idempotencyKey: 'z1' }), await P({ text: 'x', idempotencyKey: 'z2' })]; out('6 max_jobs_per_day=0 (deveria recusar tudo)', z.map(r => [r.s, r.j?.code]))
      assert.deepEqual(z.map(r => r.s), [429, 429])
      await clearJobs(); await seed(coA.id, { enabled: true, maxJobsPerDay: 2, dailyTokenBudget: 100000 }); newUser(); await P({ text: 'x', idempotencyKey: 'd1' }); await P({ text: 'x', idempotencyKey: 'd2' }); const full = await P({ text: 'x', idempotencyKey: 'd3' })
      await sql`update sac_operator_company_settings set daily_usage_date = CURRENT_DATE - 1 where company_id=${coA.id}`; const nextDay = await P({ text: 'x', idempotencyKey: 'd4' }); out('6 virada do dia reinicia o contador', [full.s, nextDay.s, await cnt()])
      await clearJobs(); await seed(coA.id, { enabled: true, maxJobsPerDay: 100, dailyTokenBudget: 1000000 }); newUser(); orMode = '500'
      const f1 = await P({ text: 'x', idempotencyKey: 'fl1' }); orMode = 'ok'; out('6 job que falha devolve a reserva?', [f1.j?.job?.status, await cnt(), (await sql`select tokens_in, tokens_out from sac_operator_jobs where idempotency_key='fl1'`)[0]])
      await clearJobs(); await seed(coA.id, { enabled: true, maxJobsPerDay: 100, dailyTokenBudget: 1000000 }); newUser()
      const same = await Promise.all(Array.from({ length: 12 }, () => P({ text: 'listar etapas', idempotencyKey: 'same-12' }))); out('6 12 simultaneas mesma chave', { jobs: (await sql`select count(*)::int c from sac_operator_jobs where idempotency_key='same-12'`)[0].c, statuses: same.map(r => r.s).sort(), contador: await cnt() })
      assert.equal((await sql`select count(*)::int c from sac_operator_jobs where idempotency_key='same-12'`)[0].c, 1)
      assert.equal((await cnt()).j, 1)
    })
    await test('8 idempotencia por minuto, job preso, request_text', async () => {
      await clearJobs(); await seed(coA.id, { enabled: true, maxJobsPerDay: 100, dailyTokenBudget: 1000000 }); newUser()
      const a = await P({ text: 'listar etapas' }), b = await P({ text: 'listar etapas' }); const realNow = Date.now; (Date as any).now = () => realNow() + 61_000; const c = await P({ text: 'listar etapas' }); (Date as any).now = realNow
      out('8 chave automatica: mesmo minuto => mesmo job; minuto seguinte => novo job', [a.j.job.id === b.j.job.id, b.j.reused, c.j.job.id !== a.j.job.id, c.s])
      out('8 UNIQUE segue valendo', await (async () => { try { await sql`insert into sac_operator_jobs (id, company_id, requested_by_user_id, role, request_text, idempotency_key) select gen_random_uuid(), company_id, 'x', 'admin', 'y', idempotency_key from sac_operator_jobs limit 1`; return 'DUPLICOU' } catch (e: any) { return e.code } })())
      await sql`insert into sac_operator_jobs (id, company_id, requested_by_user_id, role, request_text, idempotency_key, status, created_at, updated_at) values ('11111111-1111-4111-8111-111111111111', ${coA.id}, 'x', 'admin', 'preso', 'stuck-1', 'em_execucao', now() - interval '30 minutes', now() - interval '30 minutes')`
      const g1 = await G(); const st1 = g1.j.jobs.find((x: any) => x.id === '11111111-1111-4111-8111-111111111111')?.status; const j1 = (await GJ('11111111-1111-4111-8111-111111111111')).j?.job?.status
      out('8 job preso 30min: status apos GET historico e GET job', [st1, j1])
      assert.deepEqual([st1, j1], ['falhou', 'falhou'])
      await sql`insert into sac_operator_jobs (id, company_id, requested_by_user_id, role, request_text, idempotency_key, status, reserved_tokens, created_at, updated_at) values ('22222222-2222-4222-8222-222222222222', ${coA.id}, 'x', 'admin', 'pendente', 'stuck-pendente', 'pendente', 512, now() - interval '30 minutes', now() - interval '30 minutes')`
      await G(); const pending = (await sql`select status, error_code from sac_operator_jobs where id='22222222-2222-4222-8222-222222222222'`)[0]
      assert.deepEqual([pending.status, pending.error_code], ['falhou', 'JOB_TIMEOUT'])
      const re = await P({ text: 'preso', idempotencyKey: 'stuck-1' }); out('8 job preso: reenviar a mesma chave', [re.s, re.j?.job?.status, re.j?.job?.errorCode])
      newUser(); await P({ text: 'Busque maria souza e fernanda borges, tel 11999998888, joao@x.com', idempotencyKey: 'rt-1' }); out('8 request_text gravado', (await sql`select request_text from sac_operator_jobs where idempotency_key='rt-1'`)[0].request_text)
    })
    await test('1/10 efeitos em tabelas existentes', async () => {
      out('10 pausa/leads/regras/mensagens iguais', stBefore === await state()); out('10 schema existente igual', JSON.stringify(before) === JSON.stringify(await snap()))
      assert.equal(stBefore === await state(), true); assert.equal(JSON.stringify(before) === JSON.stringify(await snap()), true)
    })
  } finally { await pgn.end({ timeout: 2 }); await sql.end({ timeout: 2 }); disposable.stop() }
}
main().catch(e => { console.error('FATAL', e); process.exitCode = 1 })
