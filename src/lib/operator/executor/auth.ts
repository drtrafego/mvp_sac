import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { operatorRateLimit } from '../rate-limit'

export class ExecutorError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}
export type Executor = { id: string; empresas: number[] }
export function tokenHash(value: string) { return createHash('sha256').update(value).digest('hex') }
export function executorResponse(body: unknown, status = 200) {
  return status === 204 ? new Response(null, { status, headers: { 'Cache-Control': 'no-store' } }) : Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}
export function executorError(error: unknown) {
  const safe = error instanceof ExecutorError ? error : error instanceof z.ZodError ? new ExecutorError(400, 'INVALID_BODY') : new ExecutorError(500, 'EXECUTOR_ERROR')
  return executorResponse({ codigo: safe.code }, safe.status)
}
export async function authenticateExecutor(request: Request): Promise<Executor> {
  // Executor não utiliza cookies. Recusar todos também cobre novos nomes de
  // cookies de sessão sem manter uma lista de nomes ligada ao provedor.
  if (request.headers.get('cookie')) throw new ExecutorError(401, 'UNAUTHORIZED')
  const token = request.headers.get('authorization')?.match(/^Bearer (sacop_[A-Za-z0-9_-]{43})$/)?.[1]
  if (!token) throw new ExecutorError(401, 'UNAUTHORIZED')
  const { rows } = await db.execute<{ id: string; empresas: number[] }>(sql`SELECT id, empresas_permitidas AS empresas FROM sac_operator_executors WHERE token_hash = ${tokenHash(token)} AND revogado_em IS NULL`)
  const executor = rows[0]
  if (!executor) throw new ExecutorError(401, 'UNAUTHORIZED')
  if (!operatorRateLimit('executor:' + executor.id, 120)) throw new ExecutorError(429, 'RATE_LIMIT')
  return { id: executor.id, empresas: z.array(z.number().int().positive()).parse(typeof executor.empresas === 'string' ? JSON.parse(executor.empresas) : executor.empresas) }
}
export async function executorBody<S extends z.ZodTypeAny>(request: Request, schema: S): Promise<z.output<S>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ExecutorError(400, 'INVALID_BODY')
  const raw = await request.text()
  if (Buffer.byteLength(raw) > 32768) throw new ExecutorError(400, 'INVALID_BODY')
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new ExecutorError(400, 'INVALID_BODY') }
  return schema.parse(value)
}
export function leaseHeader(request: Request) {
  const token = request.headers.get('x-operator-lease')
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ExecutorError(409, 'LEASE_CONFLICT')
  return token
}
