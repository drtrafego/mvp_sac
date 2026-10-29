import { readFile } from 'node:fs/promises'
import path from 'node:path'

export type PublishOptions = {
  baseUrl: string
  tenant: string
  jobId: string
  mediaId: string
  text: string
  executorKey: string
  confirmed: boolean
}

export type PublishResponse = {
  status: number
  body: unknown
}

class HelpRequested extends Error {}

function usage(): string {
  return `Uso:
  SAC_API_BASE_URL=https://sac.exemplo \\
  SAC_CODEX_EXECUTOR_KEY='(fora do histórico do shell)' \\
  pnpm exec tsx scripts/publish-instagram-comment.ts \\
    --tenant empresa-slug \\
    --job-id JOB_ID \\
    --media-id 17841400000000000 \\
    --text-file ./comentario.txt \\
    --confirm

Obrigatórios: --tenant, --job-id, --media-id, --text-file e --confirm.
A confirmação humana e o status executando do job precisam existir antes desta chamada.`
}

function requiredValue(args: Map<string, string>, flag: string): string {
  const value = args.get(flag)?.trim()
  if (!value) throw new Error(`${flag} é obrigatório.`)
  return value
}

export function parsePublishArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Omit<PublishOptions, 'text'> & { textFile: string } {
  const args = new Map<string, string>()
  let confirmed = false

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--') continue
    if (flag === '--confirm') {
      confirmed = true
      continue
    }
    if (flag === '--help' || flag === '-h') throw new HelpRequested(usage())
    if (!flag?.startsWith('--')) throw new Error(`Argumento desconhecido: ${flag ?? ''}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${flag} precisa de um valor.`)
    args.set(flag, value)
    index += 1
  }

  const baseUrl = (env.SAC_API_BASE_URL ?? '').trim().replace(/\/$/, '')
  const executorKey = (env.SAC_CODEX_EXECUTOR_KEY ?? '').trim()
  if (!baseUrl) throw new Error('SAC_API_BASE_URL não está configurada.')
  if (!executorKey) throw new Error('SAC_CODEX_EXECUTOR_KEY não está configurada.')
  if (!confirmed) throw new Error('A publicação exige --confirm explícito.')

  const mediaId = requiredValue(args, '--media-id')
  if (!/^\d+$/.test(mediaId)) throw new Error('--media-id precisa ser numérico.')

  return {
    baseUrl,
    tenant: requiredValue(args, '--tenant'),
    jobId: requiredValue(args, '--job-id'),
    mediaId,
    textFile: requiredValue(args, '--text-file'),
    executorKey,
    confirmed,
  }
}

export function buildPublishRequest(options: PublishOptions): { url: string; init: RequestInit } {
  if (!options.confirmed) throw new Error('A publicação exige confirmação explícita.')
  if (!/^\d+$/.test(options.mediaId)) throw new Error('media_id inválido.')
  if (!options.text.trim() || options.text.trim().length > 2_200) {
    throw new Error('O texto precisa ter entre 1 e 2.200 caracteres.')
  }

  const url = `${options.baseUrl.replace(/\/$/, '')}/api/v1/companies/${encodeURIComponent(options.tenant)}/instagram/comments`
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.executorKey}`,
        'Content-Type': 'application/json',
        'x-codex-confirmed': 'true',
      },
      body: JSON.stringify({ jobId: options.jobId, mediaId: options.mediaId, text: options.text.trim() }),
    },
  }
}

export async function publishInstagramComment(
  options: PublishOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResponse> {
  const request = buildPublishRequest(options)
  const response = await fetchImpl(request.url, request.init)
  const body = await response.json().catch(() => ({ error: `Resposta não-JSON (HTTP ${response.status}).` }))
  return { status: response.status, body }
}

async function main() {
  try {
    const parsed = parsePublishArgs(process.argv.slice(2))
    const text = await readFile(path.resolve(parsed.textFile), 'utf8')
    const result = await publishInstagramComment({ ...parsed, text })
    process.stdout.write(`${JSON.stringify(result.body)}\n`)
    if (result.status < 200 || result.status >= 300) process.exitCode = 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process[error instanceof HelpRequested ? 'stdout' : 'stderr'].write(`${message}\n`)
    process.exitCode = error instanceof HelpRequested ? 0 : 1
  }
}

if (process.argv[1] && __filename === path.resolve(process.argv[1])) {
  void main()
}
