import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ClaimResponse, CompleteBody, FailBody } from '../../src/lib/operator/executor/contract'
import type { JsonSchema } from '../../src/lib/operator/executor/output-schema'
// @ts-expect-error Node 22 executa as extensões .ts sem transpilar.
import { allowedModel, type Model } from './config.ts'

export type FailureCode = FailBody['codigo']
export class RunnerError extends Error {
  code: FailureCode | 'LEASE_LOST'
  constructor(code: FailureCode | 'LEASE_LOST') { super(code); this.code = code }
}
export type Command = { file: string; args: string[]; cwd: string; env: Record<string, string | undefined> }
export type Launch = (command: Command) => ChildProcessWithoutNullStreams
// Next torna NODE_ENV obrigatório no tipo global, mas ele não entra no ambiente isolado.
export const launchProcess: Launch = command => spawn(command.file, command.args, { cwd: command.cwd, env: command.env as NodeJS.ProcessEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
export function killGroup(child: ChildProcessWithoutNullStreams): void {
  // PID 0 e 1 têm semântica especial no POSIX; o próprio PID nunca pode ser alvo.
  if (!child.pid || child.pid <= 1 || child.pid === process.pid) return
  try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
}
export const disabledFeatures = ['shell_tool', 'unified_exec', 'multi_agent', 'sleep_tool', 'apps', 'plugins', 'image_generation', 'browser_use', 'computer_use', 'view_image', 'goals', 'hooks', 'skill_search', 'tool_suggest']
export function codexFlags(model: Model): string[] {
  if (!allowedModel(model)) throw new RunnerError('CLI_ERROR')
  return ['--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', `model="${model}"`, '-c', 'model_reasoning_effort="low"', ...disabledFeatures.flatMap(feature => ['--disable', feature]), '--output-schema', '/work/schema.json', '--json', '-o', '/work/saida.json', '-C', '/work']
}
// bwrap recria PWD mesmo com clearenv; env -u o retira antes do CLI.
export function sandboxCommand(work: string, codexHome: string, argv: string[]): Command {
  const env = { HOME: '/work', CODEX_HOME: '/codex-home', PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }
  return { file: '/usr/bin/bwrap', cwd: work, env, args: [
    '--unshare-all', '--share-net', '--die-with-parent', '--new-session', '--clearenv',
    ...['/usr', '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/pki', '/etc/ssl', '/etc/crypto-policies'].flatMap(path => ['--ro-bind', path, path]),
    // Compatibilidade com sistemas usr-merged, sem expor outras árvores do host.
    '--symlink', 'usr/bin', '/bin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', work, '/work', '--bind', codexHome, '/codex-home',
    ...Object.entries(env).flatMap(([key, value]) => ['--setenv', key, value]), '--chdir', '/work', '--', '/usr/bin/env', '-u', 'PWD', ...argv,
  ] }
}
export function removeNullKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeNullKeys)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null).map(([key, item]) => [key, removeNullKeys(item)]))
  return value
}
// Interpreta somente o subconjunto JSON Schema exportado pela F1, sem copiar o catálogo.
export function matchesSchema(value: unknown, schema: JsonSchema, depth = 0): boolean {
  if (depth > 20 || !schema || typeof schema !== 'object') return false
  if (schema.anyOf) return schema.anyOf.some(option => matchesSchema(value, option, depth + 1))
  if (schema.enum && !schema.enum.includes(value)) return false
  switch (schema.type) {
    case 'null': return value === null
    case 'boolean': return typeof value === 'boolean'
    case 'string': return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity)
    case 'array': return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && !!schema.items && value.every(item => matchesSchema(item, schema.items!, depth + 1))
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !schema.properties) return false
      const object = value as Record<string, unknown>
      return (schema.required ?? []).every(key => Object.hasOwn(object, key)) && Object.entries(object).every(([key, item]) => Object.hasOwn(schema.properties!, key) && matchesSchema(item, schema.properties![key], depth + 1))
    }
    default: return false
  }
}
export function eventAllowed(event: Record<string, unknown>): boolean {
  if (['thread.started', 'turn.started', 'turn.completed', 'turn.failed'].includes(String(event.type))) return !Object.hasOwn(event, 'item')
  if (['item.started', 'item.updated', 'item.completed'].includes(String(event.type))) {
    const item = event.item as Record<string, unknown> | undefined
    return !!item && ['reasoning', 'agent_message'].includes(String(item.type))
  }
  return false
}
function failureFromEvent(event: Record<string, unknown>): FailureCode {
  const error = JSON.stringify(event.error ?? '').toLowerCase()
  if (/usage_limit|usagelimit|usage limit/.test(error)) return 'USAGE_LIMIT'
  if (/auth_unavailable|unauthorized|authentication|not logged in/.test(error)) return 'AUTH_UNAVAILABLE'
  return 'CLI_ERROR'
}
export type RunResult = { plano: unknown; uso: CompleteBody['uso'] }
export async function runCodex(job: ClaimResponse, work: string, options: { codexHome: string; timeoutMs: number; signal: AbortSignal; launch?: Launch }): Promise<RunResult> {
  if (!allowedModel(job.modelo)) throw new RunnerError('CLI_ERROR')
  if (options.signal.aborted) throw new RunnerError('LEASE_LOST')
  await writeFile(join(work, 'schema.json'), JSON.stringify(job.schema), { mode: 0o600 })
  if (options.signal.aborted) throw new RunnerError('LEASE_LOST')
  const command = sandboxCommand(work, options.codexHome, ['codex', 'exec', ...codexFlags(job.modelo), '-'])
  const child = (options.launch ?? launchProcess)(command)
  const usage = await new Promise<CompleteBody['uso']>((resolve, reject) => {
    let failure: RunnerError | undefined; let buffer = ''; let bytes = 0; let completed = false
    let uso: CompleteBody['uso'] | undefined
    const stop = (code: FailureCode | 'LEASE_LOST') => { failure ??= new RunnerError(code); killGroup(child) }
    const abort = () => stop('LEASE_LOST')
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
    const timer = setTimeout(() => stop('MODEL_TIMEOUT'), options.timeoutMs)
    const parseLine = (line: string) => {
      if (failure || !line.trim()) return
      try {
        const event = JSON.parse(line) as Record<string, unknown>
        if (!event || !eventAllowed(event)) { stop('TOOL_USE_DETECTED'); return }
        if (event.type === 'turn.failed') { stop(failureFromEvent(event)); return }
        if (event.type === 'turn.completed') {
          if (completed) { stop('CLI_ERROR'); return }
          completed = true
          const raw = event.usage as Record<string, unknown>
          const values = [raw?.input_tokens, raw?.cached_input_tokens, raw?.output_tokens]
          if (!values.every(value => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10_000_000) || Number(values[1]) > Number(values[0])) { stop('CLI_ERROR'); return }
          uso = { entrada: Number(values[0]), cache: Number(values[1]), saida: Number(values[2]) }
        }
      } catch { stop('TOOL_USE_DETECTED') }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > 1_000_000) { stop('TOOL_USE_DETECTED'); return }
      buffer += chunk
      let index: number
      while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); parseLine(line) }
    })
    // stderr pode conter prompt, credenciais e saída: é drenado, nunca registrado.
    child.stderr.resume()
    child.stdin.on('error', () => { /* close/error decide o resultado, sem imprimir a exceção. */ })
    child.on('error', () => { failure ??= new RunnerError('CLI_ERROR') })
    child.on('close', code => {
      clearTimeout(timer); options.signal.removeEventListener('abort', abort); parseLine(buffer); killGroup(child)
      if (failure) reject(failure)
      else if (code !== 0 || !completed || !uso) reject(new RunnerError('CLI_ERROR'))
      else resolve(uso)
    })
    child.stdin.end(JSON.stringify({ sistema: job.sistema, pedido: job.pedido }))
  })
  if (options.signal.aborted) throw new RunnerError('LEASE_LOST')
  try {
    const output = await readFile(join(work, 'saida.json'))
    if (output.length > 128_000) throw new Error('OUTPUT_SIZE')
    const plano: unknown = JSON.parse(output.toString('utf8'))
    if (!matchesSchema(plano, job.schema as JsonSchema)) throw new Error('OUTPUT_SCHEMA')
    return { plano: removeNullKeys(plano), uso: usage }
  } catch { throw new RunnerError('MODEL_INVALID_OUTPUT') }
}
