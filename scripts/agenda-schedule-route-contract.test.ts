import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/app/api/v1/companies/[idOrSlug]/agenda/schedule/route.ts', 'utf8')

test('rota de horário não bloqueia Dr. Lucas/Gramado como somente leitura', () => {
  assert.doesNotMatch(source, /status:\s*409[\s\S]{0,200}readOnly:\s*true/)
  assert.match(source, /readOnly:\s*false/)
  assert.match(source, /availabilityScheduleManual/)
})

test('rota lê configuração manual e salva em settings.availabilitySchedule', () => {
  assert.match(source, /row\?\.availabilitySchedule/)
  assert.match(source, /native_snapshot_imported/)
  assert.match(source, /\.set\(\{\s*availabilitySchedule:\s*result\.schedule/)
  assert.match(source, /availabilityScheduleManual:\s*true/)
  assert.match(source, /insert\(settings\)\.values\(\{\s*companyId:\s*context\.company\.id,\s*availabilitySchedule:\s*result\.schedule/)
})
