import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readConfig, type Config } from './sac-operator/config'
import { codexFlags, eventAllowed, killGroup, runCodex, sandboxCommand, type Command, type Launch } from './sac-operator/codex-runner'
import { selfcheck, makeProbe, inspectPromptInput, type Probe } from './sac-operator/selfcheck'
import { SacClient } from './sac-operator/sac-client'
import { Worker, type SafeLog } from './sac-operator/worker'
import { fakeJob, startFakeSac } from './sac-operator/fake-sac'
import { redactOperatorText } from '../src/lib/operator/privacy'
import { EXECUTOR_MODELS, CLI_SECONDS, HEARTBEAT_SECONDS, claimResponseSchema } from '../src/lib/operator/executor/contract'

const fakePath = resolve('scripts/sac-operator/fake-codex.mjs')
const newDir = () => mkdtemp(join(tmpdir(), 'sac-f2-'))
function fakeLaunch(mode: string, audit = '-', seen?: Command[]): Launch {
  return command => {
    seen?.push(command)
    const index = command.args.indexOf('--')
    const argv = command.args.slice(index + 4)
    assert.equal(argv[0], 'codex')
    assert.ok(command.args.includes('--clearenv'))
    return spawn(process.execPath, [fakePath, mode, command.cwd, audit, ...argv.slice(1)], { cwd: command.cwd, env: command.env as NodeJS.ProcessEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  }
}
async function fixture(mode = 'valid', pedido?: string, overrides: Partial<Config> = {}) {
  const root = await newDir(); const runDir = join(root, 'run'); const codexHome = join(root, 'home')
  await mkdir(runDir); await mkdir(codexHome)
  const server = await startFakeSac([fakeJob(pedido)])
  const config: Config = { ...readConfig({ SAC_OPERATOR_TOKEN: server.token }), runDir, codexHome, timeoutMs: 15_000, heartbeatMs: 50, ...overrides }
  const audit = join(root, 'audit.json'); const logs: SafeLog[] = []; const commands: Command[] = []
  const api = new SacClient(server.url, server.token, { allowLocalTest: true })
  let now = Date.now(); let check = true; let checkCalls = 0
  const worker = new Worker(config, {
    api, check: async () => { checkCalls++; return check }, now: () => now, log: entry => { logs.push(entry) },
    run: (job, work, signal) => runCodex(job, work, { codexHome, timeoutMs: config.timeoutMs, signal, launch: fakeLaunch(mode, audit, commands) }),
  })
  return { root, runDir, codexHome, server, config, audit, logs, commands, worker, api,
    setCheck: (value: boolean) => { check = value }, checks: () => checkCalls, advance: (ms: number) => { now += ms },
    close: async () => { await worker.shutdown(); await server.close(); await rm(root, { recursive: true, force: true }) },
  }
}
function lastCode(f: Awaited<ReturnType<typeof fixture>>) { return f.server.calls.find(call => call.path.endsWith('/fail'))?.body.codigo }
async function noJobDirectories(runDir: string) { assert.deepEqual((await readdir(runDir)).filter(name => name.startsWith('job-')), []) }

test('configuração fechada, constantes de tempo e modelos iguais ao contrato congelado', () => {
  const config = readConfig({ SAC_OPERATOR_TOKEN: 'sacop_' + 'x'.repeat(43) })
  assert.equal(config.timeoutMs, CLI_SECONDS * 1000); assert.equal(config.heartbeatMs, HEARTBEAT_SECONDS * 1000)
  assert.equal(config.maxDay, 150); assert.equal(config.selfcheckMs, 6 * 3600_000); assert.equal(config.usagePauseMs, 15 * 60_000)
  for (const model of EXECUTOR_MODELS) assert.equal(readConfig({ SAC_OPERATOR_TOKEN: config.token, OPERATOR_EXECUTOR_MODEL: model }).model, model)
  for (const extra of [{ OPERATOR_EXECUTOR_MODEL: 'unknown' }, { OPERATOR_EXECUTOR_MAX_DIA: 'NaN' }, { SAC_OPERATOR_URL: 'http://example.com' }, { SAC_OPERATOR_URL: 'https://user:secret@example.com' }, { SAC_OPERATOR_TOKEN: 'stub' }]) assert.throws(() => readConfig({ SAC_OPERATOR_TOKEN: config.token, ...extra }))
})

test('T8: dados originais ficam no SAC; argv, stdin, env, /work, claim e logs sem PII', async () => {
  const privateValues = ['Maristela', 'Zanetti', '+55 (11) 98765-4321', 'maristela@example.test', 'https://cliente.example.test/oferta', 'GirassolAzul', 'agendar chamada hoje amanhã']
  const original = `Anote no lead ${privateValues[0]} ${privateValues[1]} ${privateValues[2]} ${privateValues[3]} link ${privateValues[4]} palavra "${privateValues[5]}"\nmensagem: "${privateValues[6]}"`
  const redacted = redactOperatorText(original)
  assert.ok(redacted.markers.size >= 5)
  assert.equal(redacted.markers.get('[DM_1]'), privateValues[6])
  assert.match(redacted.text, /\[DM_1\]/)
  const f = await fixture('valid', redacted.text)
  try {
    await f.worker.tick(); await f.worker.idle()
    const capture = JSON.parse(await readFile(f.audit, 'utf8')) as { argv: string[]; stdin: string; env: Record<string, string>; files: Record<string, string> }
    assert.deepEqual(JSON.parse(capture.stdin), { sistema: fakeJob().sistema, pedido: redacted.text })
    assert.deepEqual(Object.keys(capture.env).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'PATH'])
    assert.deepEqual(Object.keys(capture.files), ['schema.json'])
    assert.equal(capture.argv[0], 'exec'); assert.equal(capture.argv.at(-1), '-')
    for (const value of privateValues) for (const boundary of [capture, f.server.calls, f.logs, f.commands]) assert.ok(!JSON.stringify(boundary).includes(value), value)
    for (const secret of ['DATABASE_URL', 'SAC_OPERATOR_TOKEN', 'OPENROUTER_API_KEY']) assert.equal(capture.env[secret], undefined)
    assert.ok(!capture.argv.includes(redacted.text)); assert.ok(!JSON.stringify(f.logs).includes(redacted.text))
    assert.ok(!JSON.stringify(capture).includes(f.server.token))
    const complete = f.server.calls.find(call => call.path.endsWith('/complete'))!
    assert.deepEqual(complete.body.uso, { entrada: 16000, cache: 15000, saida: 100 })
    assert.equal(complete.lease, 'l'.repeat(43)); assert.equal(complete.body.epoch, 1)
    assert.deepEqual(Object.keys(f.logs[0]).sort(), ['codigo', 'duracaoMs', 'jobId', 'modelo', 'tokens'])
    await noJobDirectories(f.runDir)
  } finally { await f.close() }
})

test('sandbox e flags completos: mounts exatos, ambiente reduzido, prompt fora do argv', () => {
  const command = sandboxCommand('/tmp/job', '/tmp/codex-home', ['codex', 'exec', ...codexFlags('gpt-5.6-luna'), '-'])
  for (const flag of ['--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--clearenv']) assert.ok(command.args.includes(flag), flag)
  assert.deepEqual(command.args.flatMap((arg, i) => arg === '--ro-bind' ? [command.args.slice(i + 1, i + 3)] : []), ['/usr', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/pki', '/etc/ssl', '/etc/crypto-policies'].map(path => [path, path]))
  assert.deepEqual(command.args.flatMap((arg, i) => arg === '--bind' ? [command.args.slice(i + 1, i + 3)] : []), [['/tmp/job', '/work'], ['/tmp/codex-home', '/codex-home']])
  const flags = codexFlags('gpt-5.6-luna')
  assert.deepEqual(flags.filter((_, i) => flags[i - 1] === '--disable'), ['shell_tool', 'unified_exec', 'multi_agent', 'sleep_tool', 'apps', 'plugins', 'image_generation', 'browser_use', 'computer_use', 'view_image', 'goals', 'hooks', 'skill_search', 'tool_suggest'])
  for (const flag of ['--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', 'read-only', 'approval_policy="never"', 'web_search="disabled"', 'model_reasoning_effort="low"', '/work/schema.json', '/work/saida.json', '--json']) assert.ok(flags.includes(flag), flag)
})

for (const [mode, code] of [['tool', 'TOOL_USE_DETECTED'], ['giant', 'TOOL_USE_DETECTED'], ['unknown', 'TOOL_USE_DETECTED'], ['badjson', 'TOOL_USE_DETECTED'], ['timeout', 'MODEL_TIMEOUT'], ['invalid', 'MODEL_INVALID_OUTPUT'], ['extra', 'MODEL_INVALID_OUTPUT'], ['cli', 'CLI_ERROR']] as const) {
  test(`T12/erros: ${mode} produz ${code}, apaga diretório e não repete localmente`, async () => {
    const f = await fixture(mode, undefined, { timeoutMs: mode === 'timeout' ? 160 : 15_000 })
    try {
      await f.worker.tick(); await f.worker.idle()
      assert.equal(lastCode(f), code)
      assert.equal(f.server.calls.filter(call => call.path.endsWith('/fail')).length, 1)
      assert.equal(f.server.calls.filter(call => call.path.endsWith('/complete')).length, 0)
      assert.equal(f.commands.length, 1)
      await noJobDirectories(f.runDir)
      if (['tool', 'timeout'].includes(mode)) { await delay(850); await assert.rejects(readFile(f.audit + '.child'), { code: 'ENOENT' }) }
    } finally { await f.close() }
  })
}

test('lista de eventos recusa toda ferramenta e tipo desconhecido', () => {
  for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'future_tool']) assert.equal(eventAllowed({ type: 'item.completed', item: { type } }), false)
  for (const type of ['reasoning', 'agent_message']) assert.equal(eventAllowed({ type: 'item.completed', item: { type } }), true)
  assert.equal(eventAllowed({ type: 'turn.completed', item: { type: 'command_execution' } }), false)
})

test('remove nulls do plano antes de complete sem duplicar o catálogo', async () => {
  const f = await fixture('nullable')
  try {
    await f.worker.tick(); await f.worker.idle()
    const plan = f.server.calls.find(call => call.path.endsWith('/complete'))!.body.plano as { actions: unknown[] }
    assert.deepEqual(plan.actions, [{ type: 'editar_regra_story', regra: '[REGRA1]', novaPalavra: '[T1]' }])
  } finally { await f.close() }
})

for (const status of [200, 409, 401]) test(`lease perdido ${status}: mata CLI e não chama fail, complete ou outro heartbeat`, async () => {
  const f = await fixture('slow')
  try {
    f.server.state.heartbeat = false; f.server.state.heartbeatStatus = status
    await f.worker.tick(); await f.worker.idle()
    assert.equal(f.logs.at(-1)?.codigo, 'LEASE_LOST')
    assert.equal(f.server.calls.filter(call => call.path.endsWith('/heartbeat')).length, 1)
    assert.equal(f.server.calls.filter(call => /\/(fail|complete)$/.test(call.path)).length, 0)
    await noJobDirectories(f.runDir)
  } finally { await f.close() }
})

test('heartbeat em trânsito com false vence resultado pronto', async () => {
  const f = await fixture('valid', undefined, { heartbeatMs: 1 })
  try {
    f.server.state.heartbeat = false; f.server.state.delayHeartbeat = 80
    await f.worker.tick(); await f.worker.idle()
    assert.equal(f.logs.at(-1)?.codigo, 'LEASE_LOST')
    assert.equal(f.server.calls.filter(call => /\/(fail|complete)$/.test(call.path)).length, 0)
  } finally { await f.close() }
})

test('teto global de dois processos mesmo com ticks concorrentes', async () => {
  const f = await fixture('slow', undefined, { heartbeatMs: 2000 })
  try {
    f.server.jobs.push(fakeJob(), fakeJob())
    await f.worker.tick(); await f.worker.tick()
    await Promise.all(Array.from({ length: 10 }, () => f.worker.tick()))
    assert.equal(f.server.calls.filter(call => call.path.endsWith('/claim')).length, 2)
    for (let i = 0; i < 100 && f.commands.length < 2; i++) await delay(10)
    assert.equal(f.commands.length, 2); await f.worker.shutdown()
    await noJobDirectories(f.runDir)
  } finally { await f.close() }
})

test('limite diário persiste, pausa claim, atravessa restart e renova em UTC', async () => {
  const f = await fixture('valid', undefined, { maxDay: 1 })
  try {
    await f.worker.tick(); await f.worker.idle(); f.server.jobs.push(fakeJob()); await f.worker.tick()
    assert.equal(f.server.calls.at(-1)?.body.motivo, 'DAILY_LIMIT')
    assert.equal(JSON.parse(await readFile(join(f.runDir, 'daily.json'), 'utf8')).count, 1)
    const restarted = new Worker(f.config, { api: f.api, check: async () => true, log: () => {} })
    await restarted.tick(); assert.equal(f.server.calls.at(-1)?.body.motivo, 'DAILY_LIMIT'); await restarted.shutdown()
    f.advance(24 * 3600_000); await f.worker.tick(); await f.worker.idle()
    assert.equal(f.server.calls.findLast(call => call.path.endsWith('/claim'))?.body.estado, 'pronto')
  } finally { await f.close() }
})

test('contador corrompido pausa sem executar', async () => {
  const f = await fixture()
  try { await writeFile(join(f.runDir, 'daily.json'), 'quebrado'); await f.worker.tick(); assert.equal(f.server.calls.at(-1)?.body.motivo, 'DAILY_COUNTER'); assert.equal(f.commands.length, 0) }
  finally { await f.close() }
})

test('USAGE_LIMIT pausa 15 minutos e depois permite claim', async () => {
  const f = await fixture('usage')
  try {
    await f.worker.tick(); await f.worker.idle(); assert.equal(lastCode(f), 'USAGE_LIMIT')
    await f.worker.tick(); assert.equal(f.server.calls.at(-1)?.body.motivo, 'USAGE_LIMIT')
    f.advance(15 * 60_000 - 1); await f.worker.tick(); assert.equal(f.server.calls.at(-1)?.body.estado, 'pausado')
    f.advance(1); await f.worker.tick(); assert.equal(f.server.calls.at(-1)?.body.estado, 'pronto')
  } finally { await f.close() }
})

test('AUTH_UNAVAILABLE pausa até intervenção', async () => {
  const f = await fixture('auth')
  try { await f.worker.tick(); await f.worker.idle(); await f.worker.tick(); assert.equal(lastCode(f), 'AUTH_UNAVAILABLE'); assert.equal(f.server.calls.at(-1)?.body.motivo, 'AUTH_UNAVAILABLE') }
  finally { await f.close() }
})

test('só o servidor decide a segunda tentativa, com novo epoch; nunca uma terceira', async () => {
  const f = await fixture('invalid')
  try {
    f.server.state.repeatFailures = true
    await f.worker.tick(); await f.worker.idle(); await f.worker.tick(); await f.worker.idle(); await f.worker.tick()
    assert.equal(f.commands.length, 2)
    assert.deepEqual(f.server.calls.filter(call => call.path.endsWith('/fail')).map(call => call.body.epoch), [1, 2])
  } finally { await f.close() }
})

test('T13: selfcheck no boot e a cada 6h; falha só informa pausado sem reclamar job', async () => {
  const f = await fixture()
  try {
    f.setCheck(false); await f.worker.tick()
    assert.equal(f.checks(), 1); assert.equal(f.commands.length, 0); assert.equal(f.server.jobs.length, 1)
    assert.deepEqual(f.server.calls.at(-1)?.body, { versao: 'sac-operator-f2/1', estado: 'pausado', motivo: 'CLI_SELFCHECK' })
    f.setCheck(true); f.advance(6 * 3600_000 - 1); await f.worker.tick(); assert.equal(f.checks(), 1)
    f.advance(1); await f.worker.tick(); await f.worker.idle(); assert.equal(f.checks(), 2)
  } finally { await f.close() }
})

for (const mode of ['valid', 'exec_command', 'mcp', 'nested_unknown', 'version']) test(`selfcheck com fake-codex: ${mode}`, async () => {
  const f = await fixture()
  try {
    const seen: Command[] = []
    const execute = makeProbe(fakeLaunch(mode, '-', seen))
    const probe: Probe = async command => {
      const argv = command.args.slice(command.args.indexOf('--') + 4)
      if (argv[0] === 'codex') return execute(command)
      if (argv[0] === '/usr/bin/id') return { code: 0, stdout: '1001\n', stderr: '' }
      if (argv[1] === '/work') return { code: 0, stdout: 'schema.json\n', stderr: '' }
      return { code: 2, stdout: '', stderr: 'No such file or directory' }
    }
    const passed = await selfcheck(f.config, probe)
    assert.equal(passed, mode === 'valid')
    if (mode !== 'version') assert.deepEqual(seen[1].args.slice(seen[1].args.indexOf('prompt-input') + 1), codexFlags(f.config.model))
    assert.deepEqual((await readdir(f.runDir)).filter(name => name.startsWith('selfcheck-')), [])
    if (!passed) {
      const worker = new Worker(f.config, { api: f.api, check: () => selfcheck(f.config, probe), log: () => {} })
      await worker.tick(); assert.equal(f.server.calls.at(-1)?.body.motivo, 'CLI_SELFCHECK'); assert.equal(f.server.jobs.length, 1); await worker.shutdown()
    }
  } finally { await f.close() }
})

test('selfcheck recusa formato inesperado, namespace extra e lista ausente', () => {
  for (const value of ['{}', 'sem ferramentas', '{"tools":[]}', '{"tools":[{"type":"namespace","name":"mcp","tools":[]}]}']) assert.equal(inspectPromptInput(value), false)
})

test('selfcheck não confunde bwrap quebrado com diretório inacessível', async () => {
  const f = await fixture()
  try { assert.equal(await selfcheck(f.config, async () => ({ code: 1, stdout: '', stderr: 'bwrap: namespace unavailable' })), false) }
  finally { await f.close() }
})

test('HTTP: redirecionamento proibido, sem cookies, contrato e credenciais confinados ao SAC', async () => {
  let seen: RequestInit | undefined
  const api = new SacClient('https://sac.example.test', 'sacop_stub', { fetcher: async (_url, options) => { seen = options; return new Response(null, { status: 204 }) } })
  assert.equal(await api.claim({ versao: 'test', estado: 'pronto' }), null)
  assert.equal(seen?.redirect, 'error'); assert.equal(seen?.credentials, 'omit')
  assert.throws(() => new SacClient('http://sac.example.test', 'stub'))
  assert.throws(() => claimResponseSchema.parse({ ...fakeJob(), companyId: 123 }))
})

test('bwrap REAL sem Codex: uid 1001, /work disponível, /opt e /home invisíveis', async t => {
  const root = await newDir(); const work = join(root, 'work'); const home = join(root, 'codex-home')
  await mkdir(work); await mkdir(home); await writeFile(join(work, 'visivel'), 'fixture')
  const execute = (argv: string[]) => {
    const command = sandboxCommand(work, home, argv)
    return spawnSync(command.file, command.args, { cwd: work, env: command.env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 15_000 })
  }
  try {
    const uid = execute(['/usr/bin/id', '-u'])
    if (uid.error?.message.includes('ENOENT') || /No permissions|Operation not permitted|Creating new namespace failed|setting up uid map|No space left on device/.test(uid.stderr ?? '')) { t.skip('bwrap/user namespace indisponível neste sandbox: ' + ((uid.error as NodeJS.ErrnoException | undefined)?.code ?? uid.stderr.trim())); return }
    assert.equal(uid.status, 0, uid.stderr); assert.equal(uid.stdout.trim(), '1001')
    for (const path of ['/opt', '/home']) { const result = execute(['/usr/bin/ls', path]); assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /No such file or directory/) }
    const visible = execute(['/usr/bin/ls', '/work']); assert.equal(visible.status, 0); assert.equal(visible.stdout.trim(), 'visivel')
    const env = execute(['/usr/bin/env']); assert.equal(env.status, 0); assert.deepEqual(env.stdout.trim().split('\n').map(line => line.split('=')[0]).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'PATH'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('selfcheck recusa ferramentas aninhadas desconhecidas também na sintaxe de propriedade', () => {
  const description = 'declare const tools: {\napply_patch(input: string): Promise<unknown>;\nunknown_tool: (input: string) => Promise<unknown>;\n};'
  const tools = ['exec', 'wait', 'request_user_input'].map(name => ({ type: 'function', name, description: name === 'exec' ? description : '' }))
  assert.equal(inspectPromptInput(JSON.stringify({ tools })), false)
})

test('os cinco módulos de produção carregam no Node 22 direto sem node_modules', async () => {
  const root = await newDir()
  try {
    for (const file of ['worker', 'config', 'codex-runner', 'sac-client', 'selfcheck']) await writeFile(join(root, file + '.ts'), await readFile(resolve('scripts/sac-operator', file + '.ts')))
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./worker.ts'); console.log('OK')"], { cwd: root, env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test' }, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'OK')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('M33 runner recusa terceiro modelo antes de iniciar processo', async () => {
  const root = await newDir()
  try {
    for (const modelo of ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-sol']) {
      let launched = false
      await assert.rejects(runCodex({ ...fakeJob(), modelo } as Parameters<typeof runCodex>[0], root, { codexHome: root, timeoutMs: 15_000, signal: new AbortController().signal, launch: command => { launched = true; return fakeLaunch('valid')(command) } }), { code: 'CLI_ERROR' })
      assert.equal(launched, false)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('M48 killGroup mata filho mesmo após saída normal do pai em até 5s e ignora PID inseguro', { timeout: 15_000 }, async t => {
  const root = await newDir()
  let parent: ReturnType<Launch> | undefined
  let descendant = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const alive = async (pid: number) => {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      return !/\) [ZX] /.test(stat)
    } catch { return false }
  }
  try {
    const program = `
      const {spawn}=require('node:child_process'); const fs=require('node:fs');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); child.unref();
      fs.writeFileSync('child.pid',String(child.pid));
      fs.writeFileSync('saida.json',JSON.stringify({actions:[{type:'listar_etapas'}],response:'ok'}));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));
    `
    const running = runCodex(fakeJob(), root, { codexHome: root, timeoutMs: 15_000, signal: new AbortController().signal,
      launch: command => { parent = spawn(process.execPath, ['-e', program], { cwd: command.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); return parent },
    })
    await Promise.race([running, new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: 'Runner não encerrou em 15s' })), 15_000) })])
    descendant = Number(await readFile(join(root, 'child.pid'), 'utf8'))
    const deadline = Date.now() + 5_000
    while (await alive(descendant) && Date.now() < deadline) await delay(20)
    assert.equal(await alive(descendant), false, 'Filho sobreviveu ao encerramento do grupo')
    const calls: number[] = []
    t.mock.method(process, 'kill', ((pid: number) => { calls.push(pid); return true }) as typeof process.kill)
    const childKill = t.mock.fn()
    for (const pid of [undefined, 0, 1, process.pid]) killGroup({ pid, kill: childKill } as unknown as ReturnType<Launch>)
    assert.deepEqual(calls, [])
    assert.equal(childKill.mock.callCount(), 0)
  } finally {
    if (timer) clearTimeout(timer)
    if (parent?.pid) { try { process.kill(-parent.pid, 'SIGKILL') } catch { /* Já encerrado. */ } }
    if (descendant) { try { process.kill(descendant, 'SIGKILL') } catch { /* Já encerrado. */ } }
    await rm(root, { recursive: true, force: true })
  }
})

test('R3 supervisor muda de 2s para 5s com jitter após 60s ocioso e retoma ao trabalhar', async () => {
  const f = await fixture()
  try {
    assert.equal(f.worker.pollDelayMs(), 2000)
    f.advance(59_999); assert.equal(f.worker.pollDelayMs(), 2000)
    f.advance(1)
    for (let i = 0; i < 20; i++) assert.ok(f.worker.pollDelayMs() >= 4500 && f.worker.pollDelayMs() < 5500)
    // Mantém o lease da fixture válido no relógio injetado.
    f.server.jobs[0] = { ...fakeJob(), leaseExpiraEm: new Date(Date.now() + 120_000).toISOString() }
    await f.worker.tick(); await f.worker.idle()
    assert.equal(f.worker.pollDelayMs(), 2000)
  } finally { await f.close() }
})
