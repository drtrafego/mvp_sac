import { isAbsolute } from 'node:path'
import type { ClaimResponse } from '../../src/lib/operator/executor/contract'

export type Model = ClaimResponse['modelo']
export type Config = {
  url: string; token: string; runDir: string; codexHome: string; model: Model
  maxDay: number; timeoutMs: number; heartbeatMs: number; selfcheckMs: number; usagePauseMs: number; pollMs: number
}
// O contrato é importado apenas como tipo: a instalação do supervisor não leva zod.
export function allowedModel(value: unknown): value is Model {
  return value === 'gpt-5.6-luna' || value === 'gpt-6-luna'
}
export function readConfig(env: Record<string, string | undefined> = process.env): Config {
  const url = new URL(env.SAC_OPERATOR_URL ?? 'https://sac.casaldotrafego.com')
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('CONFIG_URL')
  const token = env.SAC_OPERATOR_TOKEN ?? ''
  if (!/^sacop_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('CONFIG_TOKEN')
  const model = env.OPERATOR_EXECUTOR_MODEL ?? 'gpt-5.6-luna'
  if (!allowedModel(model)) throw new Error('CONFIG_MODEL')
  const maxDay = Number(env.OPERATOR_EXECUTOR_MAX_DIA ?? 150)
  if (!Number.isSafeInteger(maxDay) || maxDay < 1) throw new Error('CONFIG_LIMIT')
  const runDir = '/opt/gastaomatos/sac-operator/run'
  const codexHome = env.OPERATOR_EXECUTOR_CODEX_HOME ?? '/opt/gastaomatos/sac-operator/codex-home'
  if (!isAbsolute(codexHome)) throw new Error('CONFIG_HOME')
  return { url: url.origin, token, model, runDir, codexHome, maxDay, timeoutMs: 60_000, heartbeatMs: 10_000, selfcheckMs: 6 * 3600_000, usagePauseMs: 15 * 60_000, pollMs: 2000 }
}
