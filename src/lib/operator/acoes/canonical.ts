import { createHash } from 'node:crypto'
import type { PreparedAction } from './types'
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}'
  return JSON.stringify(value)
}
export function planHash(actions: PreparedAction[]) {
  return createHash('sha256').update(canonicalJson(actions.map(a => ({ ordinal: a.ordinal, tipo: a.actionType, targetId: a.targetId, request: Object.fromEntries(Object.entries(a.requestJson).filter(([k]) => k !== 'resumo')), before: a.beforeSnapshot })))).digest('hex')
}
