import { z } from 'zod'

// Contrato F1/F2. O plano é validado após a posse do job, para que uma saída
// inválida encerre o pedido em vez de permanecer reclamável indefinidamente.
export const EXECUTOR_MODELS = ['gpt-5.6-luna', 'gpt-6-luna'] as const
export const LEASE_SECONDS = 45
export const HEARTBEAT_SECONDS = 10
export const CLI_SECONDS = 60
export const JOB_SECONDS = 300
export const executorModelSchema = z.enum(EXECUTOR_MODELS)
export const epochSchema = z.number().int().positive()
export const claimBodySchema = z.object({ versao: z.string().min(1).max(100), estado: z.enum(['pronto', 'pausado']), motivo: z.string().min(1).max(100).optional() }).strict()
export const heartbeatBodySchema = z.object({ epoch: epochSchema }).strict()
// entrada inclui cache; a cota assenta entrada - cache + saida.
export const completeBodySchema = z.object({ epoch: epochSchema, plano: z.unknown().refine((v): boolean => v !== undefined), uso: z.object({ entrada: z.number().int().min(0).max(10000000), cache: z.number().int().min(0).max(10000000), saida: z.number().int().min(0).max(10000000) }).strict().refine(uso => uso.cache <= uso.entrada, 'Cache maior que a entrada.'), modelo: executorModelSchema, duracaoMs: z.number().int().min(0).max(300000) }).strict()
export const failBodySchema = z.object({ epoch: epochSchema, codigo: z.enum(['MODEL_TIMEOUT', 'MODEL_INVALID_OUTPUT', 'CLI_ERROR', 'TOOL_USE_DETECTED', 'USAGE_LIMIT', 'AUTH_UNAVAILABLE']) }).strict()
export const claimResponseSchema = z.object({ jobId: z.string().uuid(), leaseToken: z.string().min(32).max(100), epoch: epochSchema, leaseExpiraEm: z.string().datetime(), prazo: z.string().datetime(), modelo: executorModelSchema, sistema: z.string(), pedido: z.string().max(4000), schema: z.record(z.unknown()) }).strict()
export const heartbeatResponseSchema = z.object({ continuar: z.boolean() }).strict()
export const completeResponseSchema = z.object({ estado: z.enum(['aplicado', 'recusado']), codigo: z.string() }).strict()
export const failResponseSchema = z.object({ estado: z.enum(['na_fila', 'falhou']) }).strict()
export const statusResponseSchema = z.object({ disponivel: z.boolean(), ultimoContatoEm: z.string().datetime().nullable(), motivo: z.string().nullable() }).strict()
export type ClaimBody = z.infer<typeof claimBodySchema>
export type ClaimResponse = z.infer<typeof claimResponseSchema>
export type HeartbeatBody = z.infer<typeof heartbeatBodySchema>
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>
export type CompleteBody = z.infer<typeof completeBodySchema>
export type CompleteResponse = z.infer<typeof completeResponseSchema>
export type FailBody = z.infer<typeof failBodySchema>
export type FailResponse = z.infer<typeof failResponseSchema>
export type ExecutorStatus = z.infer<typeof statusResponseSchema>
