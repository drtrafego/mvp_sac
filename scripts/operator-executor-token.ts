// Utilitário manual. Não é importado pelo app, não gera credencial em dry-run.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'

const TOKEN_FILE = '/opt/gastaomatos/acessos/renato/env.sac-operator'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export async function manageToken(db: postgres.Sql, input: { action: 'criar' | 'rotacionar' | 'revogar'; nome?: string; empresas?: number[]; id?: string; file?: string }) {
  const file = input.file ?? TOKEN_FILE
  if (file !== TOKEN_FILE && !(process.env.NODE_ENV === 'test' && resolve(file).startsWith('/tmp/'))) throw new Error('Destino de teste inválido.')
  if (input.action === 'revogar') {
    if (!input.id) throw new Error('Informe o executor a revogar.')
    const rows = await db`UPDATE sac_operator_executors SET revogado_em = now(), updated_at = now() WHERE id = ${input.id}::uuid AND revogado_em IS NULL RETURNING token_prefixo`
    return { prefixo: rows[0]?.token_prefixo as string | undefined }
  }
  if (!input.nome?.trim() || !input.empresas?.length || input.empresas.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new Error('Nome e empresas explícitas são obrigatórios.')
  if (input.action === 'rotacionar') {
    if (!input.id) throw new Error('Informe o executor substituído.')
    const prior = await db`SELECT id FROM sac_operator_executors WHERE id = ${input.id}::uuid AND revogado_em IS NULL`
    if (!prior.length) throw new Error('Executor substituído indisponível.')
  } else {
    try { await readFile(file); throw new Error('Arquivo já existe. Use rotacionar.') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const value = 'sacop_' + randomBytes(32).toString('base64url')
  const prefixo = value.slice(0, 10); const id = randomUUID(); const temp = file + '.' + id
  await db`INSERT INTO sac_operator_executors (id, nome, token_hash, token_prefixo, empresas_permitidas, substitui_id) VALUES (${id}::uuid, ${input.nome}, ${hash(value)}, ${prefixo}, ${db.json(input.empresas)}, ${input.action === 'rotacionar' ? input.id! : null}::uuid)`
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const handle = await open(temp, 'wx', 0o600)
    try { await handle.writeFile('SAC_OPERATOR_TOKEN=' + value + '\n'); await handle.sync() } finally { await handle.close() }
    await chmod(temp, 0o600)
    await rename(temp, file)
  } catch {
    await db`UPDATE sac_operator_executors SET revogado_em = now(), updated_at = now() WHERE id = ${id}::uuid`
    await unlink(temp).catch(() => {})
    throw new Error('Falha ao guardar credencial; novo executor revogado.')
  }
  // Rotação mantém o antigo até reiniciar o serviço e executar revogar.
  return { prefixo }
}
async function main() {
  if (!process.argv.includes('--apply')) { console.log('Dry-run. Use criar|rotacionar|revogar --apply e as confirmações explícitas.'); return }
  if (process.env.OPERATOR_TOKEN_CONFIRM !== 'sim') throw new Error('Defina OPERATOR_TOKEN_CONFIRM=sim.')
  const url = process.env.OPERATOR_TOKEN_DATABASE_URL
  const expected = process.env.OPERATOR_TOKEN_EXPECTED_DATABASE
  if (!url || !expected || decodeURIComponent(new URL(url).pathname.slice(1)) !== expected) throw new Error('Banco não confirmado.')
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname) && process.env.OPERATOR_TOKEN_ALLOW_REMOTE !== 'sim') throw new Error('Banco remoto não confirmado.')
  const action = process.argv[2]
  if (action !== 'criar' && action !== 'rotacionar' && action !== 'revogar') throw new Error('Operação inválida.')
  const db = postgres(url, { max: 1, prepare: false })
  try {
    const result = await manageToken(db, { action, nome: process.env.OPERATOR_TOKEN_NOME, empresas: process.env.OPERATOR_TOKEN_EMPRESAS?.split(',').map(Number), id: process.env.OPERATOR_TOKEN_ID, file: process.env.NODE_ENV === 'test' ? process.env.OPERATOR_TOKEN_TEST_FILE : undefined })
    console.log(result.prefixo ?? 'Executor já revogado ou inexistente.')
  } finally { await db.end({ timeout: 5 }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main().catch(() => { console.error('Operação não concluída. Confira os parâmetros e as confirmações.'); process.exitCode = 1 })
