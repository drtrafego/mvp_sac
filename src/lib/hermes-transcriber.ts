import { CODEX_ACTION_MAX_AUDIO_BYTES } from './codex-actions'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const TRANSCRIPTION_TIMEOUT_MS = 120_000

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.split(';', 1)[0].trim().toLowerCase()
  const extensions: Record<string, string> = {
    'audio/aac': '.aac',
    'audio/flac': '.flac',
    'audio/mp4': '.m4a',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/webm': '.webm',
    'video/webm': '.webm',
  }
  return extensions[normalized] ?? extname('audio.webm')
}

function isPrivateHermesUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const hostname = url.hostname.toLowerCase()
    if (hostname === 'localhost' || hostname === 'host.docker.internal' || hostname === '::1' || hostname === '127.0.0.1') return true
    const octets = hostname.split('.').map(Number)
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
    return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)
  } catch {
    return false
  }
}

export async function transcribeWithHermes(file: File): Promise<{ transcript: string; provider?: string }> {
  const url = process.env.HERMES_TRANSCRIBE_URL?.trim()
  if (!url) throw new Error('Transcrição local do Hermes não está configurada para este servidor.')
  if (!isPrivateHermesUrl(url)) throw new Error('O endpoint do Whisper precisa apontar para o Hermes local ou uma rede privada.')
  if (file.size > CODEX_ACTION_MAX_AUDIO_BYTES) throw new Error('O áudio excede o limite de 25 MB.')

  const sharedDir = resolve(process.env.HERMES_TRANSCRIBE_SHARED_DIR?.trim() || tmpdir())
  const bytes = Buffer.from(await file.arrayBuffer())
  let workDir: string | null = null
  try {
    // O serviço local do Hermes aceita apenas video_path. O arquivo temporário
    // precisa estar em um volume visível pelo processo do Whisper; não enviamos
    // áudio a uma API externa nem inventamos um contrato data_url.
    workDir = await mkdtemp(join(sharedDir, 'sac-hermes-'))
    const filePath = join(workDir, `input${extensionForMimeType(file.type || 'audio/webm')}`)
    await writeFile(filePath, bytes, { mode: 0o600 })

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const token = process.env.HERMES_TRANSCRIBE_TOKEN?.trim()
    if (token) headers.Authorization = `Bearer ${token}`

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ video_path: filePath, language: 'pt' }),
      signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    })
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const detail = typeof payload.detail === 'string' ? payload.detail : 'o Hermes recusou a transcrição'
      throw new Error(`Falha na transcrição local: ${detail}`)
    }
    const transcript = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (!transcript) throw new Error('O Hermes não devolveu texto transcrito.')
    return { transcript, provider: typeof payload.provider === 'string' ? payload.provider : 'hermes-local' }
  } catch (error) {
    if (error instanceof Error && /ENOENT|EACCES|ENOTDIR/.test(error.message)) {
      throw new Error(`Volume compartilhado do Whisper local indisponível: ${sharedDir}`)
    }
    throw error
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true })
  }
}
