import { mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type { ClaimBody, ClaimResponse, CompleteBody } from '../../src/lib/operator/executor/contract'
// @ts-expect-error Node 22 executa as extensões .ts sem transpilar.
import { readConfig, type Config } from './config.ts'
// @ts-expect-error Node 22 executa as extensões .ts sem transpilar.
import { SacClient, type SacAPI } from './sac-client.ts'
// @ts-expect-error Node 22 executa as extensões .ts sem transpilar.
import { RunnerError, runCodex, type RunResult } from './codex-runner.ts'
// @ts-expect-error Node 22 executa as extensões .ts sem transpilar.
import { selfcheck } from './selfcheck.ts'

export type SafeLog = { jobId?: string; duracaoMs?: number; codigo: string; tokens?: CompleteBody['uso']; modelo?: ClaimResponse['modelo'] }
type Dependencies = {
  api: SacAPI; check: () => Promise<boolean>; now: () => number; log: (entry: SafeLog) => void
  run: (job: ClaimResponse, work: string, signal: AbortSignal) => Promise<RunResult>
}
export class Worker {
  private config: Config
  private deps: Dependencies
  private lastWorkAt: number
  private checkedAt = -Infinity
  private healthy = false
  private pauseUntil = 0
  private authPaused = false
  private count = 0
  private day = ''
  private counterFailed = false
  private initialized = false
  private tasks = new Set<Promise<void>>()
  private controllers = new Set<AbortController>()
  private stop = new AbortController()
  private ticking = false
  constructor(config: Config, overrides: Partial<Dependencies> = {}) {
    this.lastWorkAt = (overrides.now ?? Date.now)()
    this.config = config
    this.deps = {
      api: new SacClient(config.url, config.token), check: () => selfcheck(config), now: Date.now,
      log: entry => process.stdout.write(JSON.stringify(entry) + '\n'),
      run: (job, work, signal) => runCodex(job, work, { codexHome: config.codexHome, timeoutMs: config.timeoutMs, signal }), ...overrides,
    }
  }
  private async loadCounter(): Promise<void> {
    const day = new Date(this.deps.now()).toISOString().slice(0, 10)
    if (this.day === day) return
    try {
      const stored = JSON.parse(await readFile(join(this.config.runDir, 'daily.json'), 'utf8')) as { day: string; count: number }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(stored.day) || !Number.isSafeInteger(stored.count) || stored.count < 0 || stored.day > day) throw new Error('COUNTER')
      this.count = stored.day === day ? stored.count : 0
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.counterFailed = true; return }
      this.count = 0
    }
    this.day = day
  }
  private async reserve(): Promise<void> {
    this.count++
    const temporary = join(this.config.runDir, 'daily.tmp')
    const file = await open(temporary, 'w', 0o600)
    try { await file.writeFile(JSON.stringify({ day: this.day, count: this.count })); await file.sync() } finally { await file.close() }
    await rename(temporary, join(this.config.runDir, 'daily.json'))
  }
  private state(): ClaimBody {
    const motivo = !this.healthy ? 'CLI_SELFCHECK' : this.counterFailed ? 'DAILY_COUNTER' : this.authPaused ? 'AUTH_UNAVAILABLE' : this.pauseUntil > this.deps.now() ? 'USAGE_LIMIT' : this.count >= this.config.maxDay ? 'DAILY_LIMIT' : undefined
    return { versao: 'sac-operator-f2/1', estado: motivo ? 'pausado' : 'pronto', ...(motivo ? { motivo } : {}) }
  }
  async tick(): Promise<void> {
    if (this.ticking || this.stop.signal.aborted) return
    this.ticking = true
    try {
      if (!this.initialized) { await mkdir(this.config.runDir, { recursive: true, mode: 0o700 }); this.initialized = true }
      await this.loadCounter()
      if (this.deps.now() - this.checkedAt >= this.config.selfcheckMs) {
        this.healthy = await this.deps.check().catch(() => false)
        this.checkedAt = this.deps.now()
        if (!this.healthy) for (const controller of this.controllers) controller.abort()
      }
      if (this.tasks.size >= 2) return
      const state = this.state()
      const job = await this.deps.api.claim(state, this.stop.signal)
      if (!job || state.estado === 'pausado' || this.stop.signal.aborted) return
      this.lastWorkAt = this.deps.now()
      await this.loadCounter()
      // Uma pausa pode ter começado enquanto o long-poll estava em trânsito.
      if (this.state().estado === 'pausado') {
        if (this.pauseUntil > this.deps.now()) await this.deps.api.fail(job, 'USAGE_LIMIT')
        return
      }
      try { await this.reserve() } catch { this.counterFailed = true; await this.deps.api.fail(job, 'CLI_ERROR'); return }
      const task = this.execute(job)
      this.tasks.add(task)
      void task.finally(() => this.tasks.delete(task))
    } catch { this.deps.log({ codigo: 'SAC_UNAVAILABLE' }) }
    finally { this.ticking = false }
  }
  private async execute(job: ClaimResponse): Promise<void> {
    const started = this.deps.now()
    const controller = new AbortController(); this.controllers.add(controller)
    const heartbeatStop = new AbortController()
    let work: string | undefined; let codigo = 'CLI_ERROR'; let result: RunResult | undefined
    // Também encerra ao atingir o vencimento local, mesmo sem resposta da rede.
    let leaseDeadline = Math.min(Date.parse(job.leaseExpiraEm), Date.parse(job.prazo))
    const leaseTimer = setInterval(() => { if (this.deps.now() >= leaseDeadline) controller.abort() }, Math.min(this.config.heartbeatMs, 1000))
    const heartbeats = (async () => {
      try {
        while (!heartbeatStop.signal.aborted && !controller.signal.aborted) {
          await delay(this.config.heartbeatMs, undefined, { signal: heartbeatStop.signal })
          if (controller.signal.aborted) break
          const sentAt = this.deps.now()
          const heartbeat = await this.deps.api.heartbeat(job, controller.signal)
          if (!heartbeat.continuar) { controller.abort(); break }
          leaseDeadline = Math.min(sentAt + 45_000, Date.parse(job.prazo))
        }
      } catch { if (!heartbeatStop.signal.aborted) controller.abort() }
    })()
    try {
      if (this.deps.now() >= leaseDeadline) controller.abort()
      if (controller.signal.aborted) throw new RunnerError('LEASE_LOST')
      work = await mkdtemp(join(this.config.runDir, 'job-'))
      result = await this.deps.run(job, work, controller.signal)
      codigo = 'OK'
    } catch (error) { codigo = error instanceof RunnerError ? error.code : 'CLI_ERROR' }
    finally {
      heartbeatStop.abort(); await heartbeats; clearInterval(leaseTimer)
      if (controller.signal.aborted) codigo = 'LEASE_LOST'
      if (work) {
        try { await rm(work, { recursive: true, force: true }) }
        catch { this.healthy = false; codigo = 'CLI_ERROR' }
      }
      if (this.deps.now() >= leaseDeadline) codigo = 'LEASE_LOST'
      this.controllers.delete(controller)
    }
    // Nenhuma chamada ao SAC após perda do lease ou heartbeat false.
    if (codigo !== 'LEASE_LOST') {
      try {
        if (codigo === 'USAGE_LIMIT') this.pauseUntil = this.deps.now() + this.config.usagePauseMs
        if (codigo === 'AUTH_UNAVAILABLE') this.authPaused = true
        if (codigo === 'OK' && result) {
          await this.deps.api.complete(job, { epoch: job.epoch, plano: result.plano, uso: result.uso, modelo: job.modelo, duracaoMs: Math.min(300_000, Math.max(0, this.deps.now() - started)) })
        } else {
          await this.deps.api.fail(job, codigo as RunnerError['code'] & ('CLI_ERROR' | 'MODEL_TIMEOUT' | 'MODEL_INVALID_OUTPUT' | 'TOOL_USE_DETECTED' | 'USAGE_LIMIT' | 'AUTH_UNAVAILABLE'))
        }
      } catch { codigo = 'SAC_UNAVAILABLE' } // Complete incerto nunca é seguido de fail ou reaplicação local.
    }
    this.lastWorkAt = this.deps.now()
    this.deps.log({ jobId: job.jobId.slice(0, 8), duracaoMs: Math.max(0, this.deps.now() - started), codigo, ...(result ? { tokens: result.uso } : {}), modelo: job.modelo })
  }
  async idle(): Promise<void> { await Promise.all(this.tasks) }
  async shutdown(): Promise<void> { this.stop.abort(); for (const controller of this.controllers) controller.abort(); await this.idle() }
  pollDelayMs(): number { return this.deps.now() - this.lastWorkAt < 60_000 ? 2000 : 4500 + Math.floor(Math.random() * 1000) }
  async serve(): Promise<void> {
    while (!this.stop.signal.aborted) { await this.tick(); await delay(this.pollDelayMs(), undefined, { signal: this.stop.signal }).catch(() => {}) }
  }
}
// Uma instância por run/. Arquivo exclusivo também impede dois processos vivos
// de reservarem o mesmo contador. PID morto é recuperado no restart do systemd.
async function main(): Promise<void> {
  const config = readConfig()
  await mkdir(config.runDir, { recursive: true, mode: 0o700 })
  const lock = join(config.runDir, 'supervisor.pid')
  try {
    const pid = Number(await readFile(lock, 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('SUPERVISOR_LOCK')
    try { process.kill(pid, 0); throw new Error('SUPERVISOR_RUNNING') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    await rm(lock)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const file = await open(lock, 'wx', 0o600)
  await file.writeFile(String(process.pid)); await file.close()
  // Só após possuir o lock: remover sobras de um supervisor encerrado à força.
  for (const name of await readdir(config.runDir)) {
    if (/^(job|selfcheck)-[A-Za-z0-9]+$/.test(name)) await rm(join(config.runDir, name), { recursive: true, force: true })
  }
  const worker = new Worker(config)
  const stop = () => { void worker.shutdown() }
  process.once('SIGTERM', stop); process.once('SIGINT', stop)
  try { await worker.serve() } finally { await worker.shutdown(); await rm(lock, { force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { process.stderr.write('{"codigo":"SUPERVISOR_START_FAILED"}\n'); process.exitCode = 1 })
}
