import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const leadsPage = readFileSync(resolve(process.cwd(), 'src/app/(dashboard)/leads/page.tsx'), 'utf8')
const dispatchRoute = readFileSync(resolve(process.cwd(), 'src/app/api/leads/dispatch/route.ts'), 'utf8')
const queueSource = readFileSync(resolve(process.cwd(), 'src/lib/mass-dispatch.ts'), 'utf8')

test('Leads mantém confirmação humana no mesmo fluxo e separa salvar de iniciar', () => {
  assert.match(leadsPage, /createDispatch\('save_draft'\)/)
  assert.match(leadsPage, /createDispatch\('start'\)/)
  assert.match(leadsPage, /Salvar rascunho/)
  assert.match(leadsPage, /Iniciar disparo/)
  assert.match(leadsPage, /dispatchConfirmed/)
  assert.match(leadsPage, /role="alert"/)
  assert.doesNotMatch(leadsPage, /Criar Lote e Revisar/)
  assert.doesNotMatch(leadsPage, /router\.push\(`\/disparo-em-massa\?batchId=/)
})

test('API de Leads só enfileira na ação start e retorna lote/jobs/contagem', () => {
  assert.match(dispatchRoute, /action !== 'save_draft' && action !== 'start'/)
  assert.match(dispatchRoute, /if \(action === 'save_draft'\)/)
  assert.match(dispatchRoute, /jobsCreated: 0/)
  assert.match(dispatchRoute, /queueDirectTemplateMassDispatchBatch\(/)
  assert.match(dispatchRoute, /template\.id/)
  assert.match(dispatchRoute, /templateBodyText !== templateSnapshot\.bodyText/)
  assert.match(dispatchRoute, /templateCategory !== template\.category/)
  assert.match(dispatchRoute, /status: 'queued', jobsCreated: queued\.jobsCreated, recipientCount: leadIds\.length/)
})

test('contrato global preserva tenant, telefone, opt-out, pausa e idempotência', () => {
  assert.match(dispatchRoute, /eq\(recoveryLeads\.companyId, company\.id\)/)
  assert.match(dispatchRoute, /recoveryLeads\.phone} IS NOT NULL AND .*recoveryLeads\.phone} != ''/)
  assert.match(queueSource, /l\.whatsapp_consent_status IS DISTINCT FROM 'opted_out'/)
  assert.doesNotMatch(queueSource, /l\.bot_paused\s*(=|IS|IN)/)
  assert.match(queueSource, /pg_advisory_xact_lock/)
  assert.match(queueSource, /ON CONFLICT \(mass_dispatch_batch_id, lead_id\)/)
  assert.doesNotMatch(dispatchRoute, /isabela-fanini|companyId\s*===\s*2/)
})
