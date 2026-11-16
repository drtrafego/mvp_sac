import { acoesPlanSchema, type AcoesPlan } from '../acoes/catalog'
import { ACOES_SYSTEM_PROMPT } from '../acoes/prompt'
import type { OperatorPlan } from '../catalog'
import { createOpenRouterAdapter, type OperatorModelAdapter } from '../model-adapter'

export type OperatorPlanner = { tipo: 'sincrono'; adapter: OperatorModelAdapter<OperatorPlan | AcoesPlan> } | { tipo: 'fila' }
export function operatorPlanner(): OperatorPlanner {
  return process.env.OPERATOR_PLANNER === 'openrouter'
    ? { tipo: 'sincrono', adapter: createOpenRouterAdapter({ systemPrompt: ACOES_SYSTEM_PROMPT, parsePlan: v => acoesPlanSchema.parse(v) }) }
    : { tipo: 'fila' }
}
