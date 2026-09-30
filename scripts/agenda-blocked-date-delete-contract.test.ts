import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/app/api/v1/companies/[idOrSlug]/agenda/blocked-dates/[date]/route.ts', 'utf8')

test('delete de bloqueio vindo só do Google Calendar não toca Hermes nem apaga a linha', () => {
  assert.match(source, /existing\.source === 'google_calendar'/)
  assert.match(source, /GOOGLE_CALENDAR_BLOCK/)
  assert.match(source, /Remova o evento na agenda do Dr\. Lucas/)
})

test('delete de fonte combinada preserva o bloqueio Google e remove só a parte do bot', () => {
  assert.match(source, /existing\.source === 'google_calendar\+bot_bloqueios'/)
  assert.match(source, /source: 'google_calendar'/)
  assert.match(source, /botReason: null/)
  assert.match(source, /preservedSource: 'google_calendar'/)
})

