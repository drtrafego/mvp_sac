import type { ClaimBody, ClaimResponse, CompleteBody, CompleteResponse, FailBody, FailResponse, HeartbeatResponse } from '../../src/lib/operator/executor/contract'
// @ts-expect-error Node 22 executa as extensões .ts sem transpilar.
import { allowedModel } from './config.ts'

export interface SacAPI {
  claim(body: ClaimBody, signal?: AbortSignal): Promise<ClaimResponse | null>
  heartbeat(job: ClaimResponse, signal?: AbortSignal): Promise<HeartbeatResponse>
  complete(job: ClaimResponse, body: CompleteBody): Promise<CompleteResponse>
  fail(job: ClaimResponse, codigo: FailBody['codigo']): Promise<FailResponse>
}
export class SacError extends Error {
  status: number
  constructor(status: number) { super('SAC_HTTP'); this.status = status }
}
export class SacClient implements SacAPI {
  private url: string
  private token: string
  private fetcher: typeof fetch
  constructor(url: string, token: string, options: { fetcher?: typeof fetch; allowLocalTest?: boolean } = {}) {
    const parsed = new URL(url)
    if ((parsed.protocol !== 'https:' && !(options.allowLocalTest && parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('CONFIG_URL')
    this.url = parsed.origin; this.token = token; this.fetcher = options.fetcher ?? fetch
  }
  private async post(path: string, body: unknown, job?: ClaimResponse, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(`${this.url}/api/operator-executor/${path}`, {
      method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...(job ? { 'X-Operator-Lease': job.leaseToken } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
    })
    if (!response.ok) { await response.body?.cancel(); throw new SacError(response.status) }
    if (response.status === 204) return null
    // Limite também na leitura por streaming: Content-Length pode estar ausente.
    const reader = response.body?.getReader()
    if (!reader) throw new SacError(502)
    let bytes = 0; const chunks: Uint8Array[] = []
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 256_000) throw new SacError(502); chunks.push(part.value) }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } finally { await reader.cancel() }
  }
  async claim(body: ClaimBody, signal?: AbortSignal): Promise<ClaimResponse | null> {
    const value = await this.post('claim', body, undefined, signal)
    if (value === null) return null
    // Guarda de transporte; o schema de contrato completo é aplicado pelo SAC e pelo servidor falso.
    const job = value as ClaimResponse
    if (!job || !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(job.jobId) || typeof job.leaseToken !== 'string' || !/^[A-Za-z0-9_-]{32,100}$/.test(job.leaseToken) || !Number.isSafeInteger(job.epoch) || job.epoch < 1 || !allowedModel(job.modelo) || typeof job.sistema !== 'string' || typeof job.pedido !== 'string' || job.pedido.length > 4000 || !job.schema || typeof job.schema !== 'object' || !Number.isFinite(Date.parse(job.prazo)) || !Number.isFinite(Date.parse(job.leaseExpiraEm))) throw new SacError(502)
    return job
  }
  async heartbeat(job: ClaimResponse, signal?: AbortSignal): Promise<HeartbeatResponse> {
    const value = await this.post(`jobs/${job.jobId}/heartbeat`, { epoch: job.epoch }, job, signal) as HeartbeatResponse
    if (typeof value?.continuar !== 'boolean') throw new SacError(502)
    return value
  }
  async complete(job: ClaimResponse, body: CompleteBody): Promise<CompleteResponse> {
    const value = await this.post(`jobs/${job.jobId}/complete`, body, job) as CompleteResponse
    if (!value || !['aplicado', 'recusado'].includes(value.estado) || typeof value.codigo !== 'string') throw new SacError(502)
    return value
  }
  async fail(job: ClaimResponse, codigo: FailBody['codigo']): Promise<FailResponse> {
    const value = await this.post(`jobs/${job.jobId}/fail`, { epoch: job.epoch, codigo }, job) as FailResponse
    if (!value || !['na_fila', 'falhou'].includes(value.estado)) throw new SacError(502)
    return value
  }
}
