import { cp, mkdtemp, copyFile, symlink, rm, writeFile } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import postgres from 'postgres'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const name = `sac-e2e-${process.pid}-${randomBytes(4).toString('hex')}`
let runtime, child, containerStarted = false, stopping = false
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'development',
  NEXT_TELEMETRY_DISABLED: '1',
  SAC_E2E: '1',
  AGENT_SESSION_SECRET: 'e2e-only-not-a-production-secret',
  CRON_SECRET: 'e2e-only-cron',
  SAC_WEBHOOK_SECRET: 'e2e-only-webhook',
  // Sem Stack, credenciais de provedores, banco externo ou .env herdado.
}
async function stop(code) {
  if (stopping) return
  stopping = true
  if (child && child.exitCode === null) {
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 3000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
  }
  if (containerStarted) execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  if (runtime) await rm(runtime, { recursive: true, force: true })
  process.exitCode = code
}
process.on('SIGTERM', () => void stop(0))
process.on('SIGINT', () => void stop(130))
try {
  // Falha visível: Docker indisponível nunca vira skip/sucesso.
  execFileSync('docker', ['info'], { stdio: 'ignore' })
  const password = randomBytes(24).toString('hex')
  execFileSync('docker', ['run', '--rm', '-d', '--name', name,
    '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=sac_e2e',
    '-p', '127.0.0.1::5432', 'postgres:16-alpine'], { stdio: 'pipe' })
  containerStarted = true
  const mapping = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim()
  if (!/^127\.0\.0\.1:\d+$/.test(mapping)) throw new Error('Porta Docker inesperada')
  env.DATABASE_URL = `postgres://postgres:${password}@${mapping}/sac_e2e`
  const sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 1 })
  try {
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      try { await sql`select 1`; ready = true; break } catch { await new Promise(r => setTimeout(r, 500)) }
    }
    if (!ready) throw new Error('Postgres descartável não iniciou')
  } finally { await sql.end({ timeout: 1 }) }

  runtime = await mkdtemp(path.join(root, '.e2e-runtime-'))
  for (const entry of ['src', 'public']) await cp(path.join(root, entry), path.join(runtime, entry), { recursive: true })
  for (const entry of ['package.json', 'tsconfig.json', 'postcss.config.mjs', 'drizzle.config.ts', 'next.config.ts']) {
    await copyFile(path.join(root, entry), path.join(runtime, entry))
  }
  await symlink(path.join(root, 'node_modules'), path.join(runtime, 'node_modules'), 'dir')
  execFileSync(process.execPath, [path.join(root, 'node_modules/drizzle-kit/bin.cjs'), 'push', '--force'],
    { cwd: runtime, env, stdio: 'inherit' })
  execFileSync(process.execPath, ['--import', 'tsx', path.join(root, 'tests/e2e/support/seed.ts')],
    { cwd: root, env, stdio: 'inherit' })
  await copyFile(path.join(root, 'tests/e2e/support/db.ts'), path.join(runtime, 'src/lib/db/index.ts'))
  // Fontes externas não são objeto destes smoke tests. Mantém layout e classes.
  await writeFile(path.join(runtime, 'src/e2e-fonts.ts'),
    "export const Geist = (_options: unknown) => ({ variable: '' }); export const Geist_Mono = Geist;\n")
  const { readFile } = await import('node:fs/promises')
  const layoutPath = path.join(runtime, 'src/app/layout.tsx')
  await writeFile(layoutPath, (await readFile(layoutPath, 'utf8')).replace("from 'next/font/google'", "from '../e2e-fonts'"))
  env.NODE_OPTIONS = `--require=${path.join(root, 'tests/e2e/support/network-guard.cjs')}`
  child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack',
    '--hostname', '127.0.0.1', '--port', '3217'], { cwd: runtime, env, stdio: 'inherit' })
  child.once('error', () => { if (!stopping) void stop(1) })
  child.once('exit', code => { if (!stopping) void stop(code || 1) })
} catch (error) {
  // Não imprime DATABASE_URL nem argumentos do docker (senha efêmera).
  console.error('E2E não iniciou:', error.code || error.message?.split('\n')[0])
  await stop(1)
}
