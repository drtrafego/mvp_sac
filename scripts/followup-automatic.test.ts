import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeSteps,
  sanitizeWindow,
  sanitizeSpacing,
  isDelayStep,
  FOLLOWUP_DEFAULT_STEPS,
  FOLLOWUP_DEFAULT_WINDOW,
  FOLLOWUP_DEFAULT_SPACING,
  FollowupStep,
} from '../src/lib/followup'

test('sanitizeSteps sanitiza corretamente degraus de tempo e próximo dia', () => {
  const rawInput = [
    { delayMinutes: 30 },
    { delayMinutes: 15 },
    { delayMinutes: 30 }, // duplicado
    { nextDayAtHour: 14 },
    { nextDayAtHour: 10 },
    { nextDayAtHour: 14 }, // duplicado
    { delayMinutes: -5 },  // invalido
    { nextDayAtHour: 30 }, // invalido
  ]

  const clean = sanitizeSteps(rawInput)

  assert.equal(clean.length, 4)
  // Devem vir primeiro os por tempo ordenados, depois os do dia seguinte ordenados
  assert.deepEqual(clean[0], { delayMinutes: 15 })
  assert.deepEqual(clean[1], { delayMinutes: 30 })
  assert.deepEqual(clean[2], { nextDayAtHour: 10 })
  assert.deepEqual(clean[3], { nextDayAtHour: 14 })
})

test('sanitizeWindow valida início e fim de horário', () => {
  assert.deepEqual(sanitizeWindow({ startHour: 8, endHour: 20 }), { startHour: 8, endHour: 20 })
  assert.equal(sanitizeWindow({ startHour: 22, endHour: 8 }), undefined) // fim menor que inicio
  assert.equal(sanitizeWindow({ startHour: -1, endHour: 12 }), undefined)
  assert.equal(sanitizeWindow({ startHour: 10, endHour: 25 }), undefined)
})

test('sanitizeSpacing valida min e max segundos anti-bloqueio', () => {
  assert.deepEqual(sanitizeSpacing({ minSeconds: 50, maxSeconds: 170 }), { minSeconds: 50, maxSeconds: 170 })
  assert.equal(sanitizeSpacing({ minSeconds: 200, maxSeconds: 100 }), undefined) // min > max
  assert.equal(sanitizeSpacing({ minSeconds: 2, maxSeconds: 100 }), undefined) // min < 5s
  assert.equal(sanitizeSpacing({ minSeconds: 50, maxSeconds: 4000 }), undefined) // max > 3600s
})

test('isDelayStep identifica corretamente os tipos de degrau', () => {
  const stepA: FollowupStep = { delayMinutes: 60 }
  const stepB: FollowupStep = { nextDayAtHour: 15 }

  assert.equal(isDelayStep(stepA), true)
  assert.equal(isDelayStep(stepB), false)
})
