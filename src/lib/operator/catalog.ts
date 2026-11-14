import { z } from 'zod'

const readActionTypes = ['buscar_lead', 'listar_etapas', 'listar_regras_instagram'] as const
export const futureActionTypes = ['move_lead', 'add_note', 'instagram_rule'] as const
export type OperatorReadActionType = typeof readActionTypes[number]
export type OperatorFutureActionType = typeof futureActionTypes[number]
export type OperatorActionType = OperatorReadActionType | OperatorFutureActionType

export const operatorActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('buscar_lead'), query: z.string().min(1).max(200) }),
  z.object({ type: z.literal('listar_etapas') }),
  z.object({ type: z.literal('listar_regras_instagram') }),
  z.object({ type: z.literal('move_lead'), leadId: z.number().int().positive(), stage: z.string().min(1).max(120) }),
  z.object({ type: z.literal('add_note'), leadId: z.number().int().positive(), body: z.string().min(1).max(2000) }),
  z.object({ type: z.literal('instagram_rule'), keyword: z.string().min(1).max(80), link: z.string().url() }),
])

export const operatorPlanSchema = z.object({
  actions: z.array(operatorActionSchema).min(1).max(3),
  response: z.string().min(1).max(800),
}).strict()
export type OperatorPlan = z.infer<typeof operatorPlanSchema>

export const OPERATOR_ACTION_CATALOG = {
  buscar_lead: { phase: 'leitura', execution: 'executa_direto' },
  listar_etapas: { phase: 'leitura', execution: 'executa_direto' },
  listar_regras_instagram: { phase: 'leitura', execution: 'executa_direto' },
  move_lead: { phase: 'fase_futura', execution: 'exige_confirmacao' },
  add_note: { phase: 'fase_futura', execution: 'executa_direto' },
  instagram_rule: { phase: 'fase_futura', execution: 'exige_confirmacao' },
} as const

export function isReadAction(type: OperatorActionType): type is OperatorReadActionType {
  return (readActionTypes as readonly string[]).includes(type)
}

export function assertPhaseZeroPlan(plan: OperatorPlan): OperatorPlan {
  if (plan.actions.some(action => !isReadAction(action.type))) throw new Error('Ação fora do catálogo da Fase 0.')
  return plan
}
