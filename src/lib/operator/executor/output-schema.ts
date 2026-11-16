import { z } from 'zod'
import { acaoSchema } from '../acoes/catalog'

export type JsonSchema = { type?: string; enum?: unknown[]; anyOf?: JsonSchema[]; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: false; items?: JsonSchema; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number }
function fieldSchema(field: z.ZodTypeAny): JsonSchema {
  if (field instanceof z.ZodOptional) return { anyOf: [fieldSchema(field.unwrap()), { type: 'null' }] }
  if (field instanceof z.ZodLiteral) return { type: 'string', enum: [field.value] }
  if (field instanceof z.ZodEnum) return { type: 'string', enum: field.options }
  if (field instanceof z.ZodBoolean) return { type: 'boolean' }
  if (field instanceof z.ZodString) return { type: 'string', ...(field.minLength !== null ? { minLength: field.minLength } : {}), ...(field.maxLength !== null ? { maxLength: field.maxLength } : {}) }
  throw new Error('Tipo sem representação no contrato do executor.')
}
// Derivado do catálogo: opcionais são obrigatórios nullable no CLI. A F2
// retira os nulls antes de completar; o SAC sempre revalida pelo catálogo.
export const operatorOutputSchema: JsonSchema = {
  type: 'object', additionalProperties: false, required: ['actions', 'response'], properties: {
    actions: { type: 'array', minItems: 1, maxItems: 3, items: { anyOf: acaoSchema.options.map(action => ({ type: 'object', additionalProperties: false, required: Object.keys(action.shape), properties: Object.fromEntries(Object.entries(action.shape).map(([key, value]) => [key, fieldSchema(value)])) })) } },
    response: { type: 'string', minLength: 1, maxLength: 800 },
  },
}
