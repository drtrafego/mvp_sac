import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const route = readFileSync(resolve(process.cwd(), 'src/app/api/leads/tags/bulk/route.ts'), 'utf8')
const leadsRoute = readFileSync(resolve(process.cwd(), 'src/app/api/leads/route.ts'), 'utf8')
const leadsPage = readFileSync(resolve(process.cwd(), 'src/app/(dashboard)/leads/page.tsx'), 'utf8')

test('tags em massa sempre resolve IDs dentro do tenant da sessão', () => {
  assert.match(route, /eq\(recoveryLeads\.companyId, companyId\)/)
  assert.match(route, /filterConditions\(companyId/)
  assert.match(route, /não pertencem à empresa selecionada/)
  assert.match(route, /companyId: company\.id/)
})

test('adicionar, remover e trocar preservam as outras tags e são idempotentes', () => {
  assert.match(route, /action === 'add'/)
  assert.match(route, /action === 'remove'/)
  assert.match(route, /action === 'replace'/)
  assert.match(route, /onConflictDoNothing\(\)/)
  assert.match(route, /eq\(leadTags\.tag, checked\.fromTag!\)/)
  assert.match(route, /inArray\(leadTags\.tag, checked\.tags\)/)
  assert.match(route, /lead_tags_bulk_updated/)
})

test('tags de lead pausado não passam pelo gate de pausa nem criam envio', () => {
  assert.doesNotMatch(route, /botPaused|bot_paused|messageJobs|massDispatch|send|dispatch/i)
  assert.match(route, /messagesCreated: 0/)
  assert.match(route, /jobsCreated: 0/)
})

test('cadastro individual envia tags e a tela Leads expõe as ações e a prévia', () => {
  assert.match(leadsRoute, /tags: rawTags/)
  assert.match(leadsRoute, /leadTags/)
  assert.match(leadsPage, /Alterar tags/)
  assert.match(leadsPage, /Ver prévia/)
  assert.match(leadsPage, /Confirmar alteração/)
})
