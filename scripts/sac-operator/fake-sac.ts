// Somente teste. Os schemas reais da F1 são a autoridade do servidor falso.
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { claimBodySchema, claimResponseSchema, completeBodySchema, completeResponseSchema, failBodySchema, failResponseSchema, heartbeatBodySchema, heartbeatResponseSchema, type ClaimResponse } from '../../src/lib/operator/executor/contract'
import { operatorOutputSchema } from '../../src/lib/operator/executor/output-schema'

export function fakeJob(pedido = 'Liste as etapas.'): ClaimResponse {
  return claimResponseSchema.parse({ jobId: randomUUID(), leaseToken: 'l'.repeat(43), epoch: 1, leaseExpiraEm: new Date(Date.now() + 45_000).toISOString(), prazo: new Date(Date.now() + 300_000).toISOString(), modelo: 'gpt-5.6-luna', sistema: 'Retorne apenas um plano JSON do catálogo.', pedido, schema: operatorOutputSchema })
}
export async function startFakeSac(jobs: ClaimResponse[] = []) {
  const token = 'sacop_' + 's'.repeat(43)
  const calls: Array<{ path: string; body: Record<string, unknown>; lease?: string }> = []
  const active = new Map<string, ClaimResponse>()
  const attempts = new Map<string, number>()
  const state = { heartbeat: true, heartbeatStatus: 200, repeatFailures: false, delayHeartbeat: 0 }
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${token}` || req.headers.cookie || req.method !== 'POST') { res.writeHead(401).end(); return }
      let raw = ''; for await (const chunk of req) raw += String(chunk)
      const body = JSON.parse(raw) as Record<string, unknown>
      const path = req.url ?? ''
      calls.push({ path, body, lease: req.headers['x-operator-lease'] as string | undefined })
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json')
      if (path === '/api/operator-executor/claim') {
        const claim = claimBodySchema.parse(body)
        const job = claim.estado === 'pronto' && active.size < 2 ? jobs.shift() : undefined
        if (!job) { res.writeHead(204).end(); return }
        attempts.set(job.jobId, (attempts.get(job.jobId) ?? 0) + 1); active.set(job.jobId, job)
        res.end(JSON.stringify(claimResponseSchema.parse(job))); return
      }
      const match = path.match(/^\/api\/operator-executor\/jobs\/([^/]+)\/(heartbeat|complete|fail)$/)
      if (!match) { res.writeHead(404).end(); return }
      const job = active.get(match[1])
      if (!job || job.epoch !== body.epoch || job.leaseToken !== req.headers['x-operator-lease']) { res.writeHead(409).end(); return }
      if (match[2] === 'heartbeat') {
        heartbeatBodySchema.parse(body)
        if (state.delayHeartbeat) await new Promise(resolve => setTimeout(resolve, state.delayHeartbeat))
        if (state.heartbeatStatus !== 200) { res.writeHead(state.heartbeatStatus).end(); return }
        res.end(JSON.stringify(heartbeatResponseSchema.parse({ continuar: state.heartbeat }))); return
      }
      active.delete(job.jobId)
      if (match[2] === 'complete') {
        completeBodySchema.parse(body)
        res.end(JSON.stringify(completeResponseSchema.parse({ estado: 'aplicado', codigo: 'OK' }))); return
      }
      const fail = failBodySchema.parse(body)
      const retry = state.repeatFailures && ['CLI_ERROR', 'MODEL_TIMEOUT', 'MODEL_INVALID_OUTPUT'].includes(fail.codigo) && attempts.get(job.jobId)! < 2
      if (retry) jobs.push({ ...job, epoch: job.epoch + 1 })
      res.end(JSON.stringify(failResponseSchema.parse({ estado: retry ? 'na_fila' : 'falhou' })))
    } catch { res.writeHead(400).end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('FAKE_ADDRESS')
  return { url: `http://127.0.0.1:${address.port}`, token, calls, state, jobs, attempts,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) },
  }
}
