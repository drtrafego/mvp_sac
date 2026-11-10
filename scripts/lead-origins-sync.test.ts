import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { EDITABLE_LEAD_SOURCES } from '../src/lib/lead-origins'

test('EDITABLE_LEAD_SOURCES espelha SOURCE_OPTIONS do AddLeadModal', () => {
  const src = readFileSync(new URL('../src/components/leads/AddLeadModal.tsx', import.meta.url), 'utf8')
  const block = src.slice(src.indexOf('export const SOURCE_OPTIONS'), src.indexOf('export const MEDIUM_OPTIONS'))
  const keys = [...block.matchAll(/^\s{2}([a-z_]+):/gm)].map(m => m[1])
  assert.deepEqual([...keys].sort(), [...EDITABLE_LEAD_SOURCES].sort())
})
