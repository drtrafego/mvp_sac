// Exclusivo dos testes: não chama serviços nem carrega credenciais.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const mode = args[0]
const work = args[1]
const audit = args[2]
const actualArgs = args.slice(3)
const nested = 'declare const tools: {\napply_patch(input: string): Promise<unknown>;\nlist_mcp_resources(args: {}): Promise<unknown>;\n};'
const tools = [
  { type: 'custom', name: 'exec', description: nested },
  { type: 'function', name: 'wait', description: '' },
  { type: 'function', name: 'request_user_input', description: '' },
]
if (actualArgs.includes('--version')) {
  console.log(mode === 'version' ? 'codex-cli 0.168.0' : 'codex-cli 0.167.2')
} else if (actualArgs.includes('prompt-input')) {
  if (mode === 'exec_command') tools[0].description = nested.replace('apply_patch', 'exec_command')
  if (mode === 'mcp') tools.push({ type: 'function', name: 'mcp__external__read', description: '' })
  if (mode === 'nested_unknown') tools[0].description = nested.replace('apply_patch', 'new_tool')
  console.log(JSON.stringify({ tools }))
} else {
  let stdin = ''
  for await (const chunk of process.stdin) stdin += chunk.toString()
  if (audit !== '-') {
    const files = Object.fromEntries(await Promise.all((await readdir(work)).map(async name => [name, await readFile(join(work, name), 'utf8')])))
    await writeFile(audit, JSON.stringify({ argv: actualArgs, stdin, env: process.env, files, pid: process.pid }))
  }
  const emit = event => console.log(JSON.stringify(event))
  emit({ type: 'thread.started', thread_id: 'fake' })
  emit({ type: 'turn.started' })
  if (['tool', 'timeout', 'unknown', 'badjson', 'slow', 'giant'].includes(mode)) {
    if (audit !== '-') spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "sobreviveu"), 700)', audit + '.child'], { stdio: 'ignore' })
    if (mode === 'tool') emit({ type: 'item.started', item: { id: 'fake', type: 'command_execution', command: 'conteúdo proibido' } })
    if (mode === 'unknown') emit({ type: 'unknown.future.event' })
    if (mode === 'giant') emit({ type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(1_000_001) } })
    if (mode === 'badjson') console.log('JSON inválido')
    setInterval(() => {}, 1000)
  } else if (['usage', 'auth', 'cli'].includes(mode)) {
    emit({ type: 'turn.failed', error: { codex_error_info: mode === 'usage' ? 'UsageLimitExceeded' : mode === 'auth' ? 'AUTH_UNAVAILABLE' : 'CLI_ERROR', message: 'não registrar conteúdo privado' } })
    setInterval(() => {}, 1000)
  } else {
    let plan = { actions: [{ type: 'listar_etapas' }], response: 'Etapas disponíveis.' }
    if (mode === 'nullable') plan = { actions: [{ type: 'editar_regra_story', regra: '[REGRA1]', novaPalavra: '[T1]', novaMensagem: null, novaCorrespondencia: null }], response: 'Alteração preparada.' }
    if (mode === 'extra') plan.actions[0].companyId = 5329
    await writeFile(join(work, 'saida.json'), mode === 'invalid' ? '{inválido' : JSON.stringify(plan))
    emit({ type: 'item.completed', item: { id: 'fake', type: 'agent_message', text: JSON.stringify(plan) } })
    emit({ type: 'turn.completed', usage: { input_tokens: 16000, cached_input_tokens: 15000, output_tokens: 100 } })
  }
}
