import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from './config'
// @ts-expect-error Node 22 executa as extensões .ts sem transpilar.
import { codexFlags, killGroup, launchProcess, sandboxCommand, type Command, type Launch } from './codex-runner.ts'

export type ProbeResult = { code: number | null; stdout: string; stderr: string }
export type Probe = (command: Command) => Promise<ProbeResult>
export function makeProbe(launch: Launch = launchProcess): Probe {
  return command => new Promise((resolve, reject) => {
    const child = launch(command)
    let stdout = ''; let stderr = ''; let exceeded = false
    const timer = setTimeout(() => { exceeded = true; killGroup(child) }, 10_000)
    const collect = (chunk: Buffer, target: 'stdout' | 'stderr') => {
      if (target === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8')
      if (stdout.length + stderr.length > 512_000) { exceeded = true; killGroup(child) }
    }
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'))
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'))
    child.stdin.on('error', () => {})
    child.once('error', () => { clearTimeout(timer); reject(new Error('CLI_SELFCHECK')) })
    child.once('close', code => { clearTimeout(timer); killGroup(child); if (exceeded) reject(new Error('CLI_SELFCHECK')); else resolve({ code, stdout, stderr }) })
    child.stdin.end()
  })
}
// prompt-input é inspecionado como uma descrição de ferramentas, nunca por uma
// busca de palavras no pedido. Formato não reconhecido mantém o supervisor pausado.
export function inspectPromptInput(text: string): boolean {
  try {
    const prompt = JSON.parse(text) as { tools?: unknown[] }
    if (!Array.isArray(prompt.tools)) return false
    const names: string[] = []; const descriptions: string[] = []
    for (const raw of prompt.tools) {
      if (!raw || typeof raw !== 'object') return false
      const tool = raw as Record<string, unknown>
      if (tool.type === 'namespace' && tool.name === 'functions' && Array.isArray(tool.tools)) {
        for (const inner of tool.tools) {
          if (!inner || typeof inner !== 'object' || !['function', 'custom'].includes(inner.type)) return false
          names.push(inner.name); descriptions.push(String(inner.description ?? ''))
        }
      } else if (['function', 'custom'].includes(String(tool.type)) && typeof tool.name === 'string') {
        names.push(tool.name.replace(/^functions\./, '')); descriptions.push(String(tool.description ?? ''))
      } else return false
    }
    if (names.length !== 3 || [...names].sort().join(',') !== 'exec,request_user_input,wait') return false
    const description = descriptions[names.indexOf('exec')]
    if (/exec_command|mcp__|namespace\s+(?!functions\b)/.test(description)) return false
    const nested: string[] = []
    for (const match of description.matchAll(/declare\s+const\s+tools\s*:\s*\{/g)) {
      let depth = 1; let parentheses = 0; let member = ''; let closed = false
      for (let i = match.index! + match[0].length; i < description.length; i++) {
        const char = description[i]
        if (char === '{') depth++
        if (char === '}') depth--
        if (char === '(') parentheses++
        if (char === ')') parentheses--
        if (depth === 0) { if (member.trim()) return false; closed = true; break }
        if (char === ';' && depth === 1 && parentheses === 0) {
          const declaration = member.replace(/\/\/[^\n]*/g, '').trim().match(/^(\w+)\s*[:(]/)
          if (!declaration) return false
          nested.push(declaration[1]); member = ''
        } else member += char
      }
      if (!closed) return false
    }
    const allowed = new Set(['apply_patch', 'list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource'])
    return nested.length > 0 && nested.every(name => allowed.has(name))
  } catch { return false }
}
export async function selfcheck(config: Config, probe: Probe = makeProbe()): Promise<boolean> {
  let work: string | undefined
  try {
    const homeFiles = await readdir(config.codexHome)
    if (homeFiles.some(name => ['config.toml', 'skills', 'plugins', 'AGENTS.md'].includes(name))) return false
    work = await mkdtemp(join(config.runDir, 'selfcheck-'))
    await writeFile(join(work, 'schema.json'), '{"type":"object","properties":{},"additionalProperties":false}', { mode: 0o600 })
    const command = (argv: string[]) => sandboxCommand(work!, config.codexHome, argv)
    const version = await probe(command(['codex', '--version']))
    if (version.code !== 0 || !/^codex-cli 0\.167\.\d+\s*$/.test(version.stdout)) return false
    // O claim pode selecionar qualquer um dos dois modelos do contrato.
    const models: Config['model'][] = [config.model, config.model === 'gpt-5.6-luna' ? 'gpt-6-luna' : 'gpt-5.6-luna']
    for (const model of models) {
      const prompt = await probe(command(['codex', 'debug', 'prompt-input', ...codexFlags(model)]))
      if (prompt.code !== 0 || !inspectPromptInput(prompt.stdout)) return false
    }
    // Um erro ao criar o namespace não pode ser confundido com isolamento correto.
    const uid = await probe(command(['/usr/bin/id', '-u']))
    if (uid.code !== 0 || uid.stdout.trim() !== '1001') return false
    for (const path of ['/opt', '/home']) {
      const hidden = await probe(command(['/usr/bin/ls', path]))
      if (hidden.code !== 2 || !hidden.stderr.includes('No such file or directory') || hidden.stdout.trim()) return false
    }
    const visible = await probe(command(['/usr/bin/ls', '/work']))
    return visible.code === 0 && visible.stdout.split('\n').includes('schema.json')
  } catch { return false }
  finally { if (work) await rm(work, { recursive: true, force: true }) }
}
