import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getAvailableVariableSources,
  renderTemplateVariableTextStrict,
  unresolvedTemplateVariableKeys,
} from '../src/lib/lead-template-variables'

const leadsPage = readFileSync(resolve(process.cwd(), 'src/app/(dashboard)/leads/page.tsx'), 'utf8')
const dispatchRoute = readFileSync(resolve(process.cwd(), 'src/app/api/leads/dispatch/route.ts'), 'utf8')
const queueSource = readFileSync(resolve(process.cwd(), 'src/lib/mass-dispatch.ts'), 'utf8')
const statusRoute = readFileSync(resolve(process.cwd(), 'src/app/api/leads/dispatch/[batchId]/route.ts'), 'utf8')

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

test('prévia de template mantém ordem posicional e não inventa valores ausentes', () => {
  const lead = { name: 'Gastão', phone: '5511999993210', productName: 'Quiz Isabella', email: 'g@example.test', cpfCnpj: '' }
  const body = 'Olá {{5}}\n{{1}}\n{{3}}\n{{2}}'
  const variables = { '1': '{primeiro_nome}', '2': '{produto}', '3': '{cpf}', '5': '{telefone}' }

  assert.equal(renderTemplateVariableTextStrict(body, variables, lead), 'Olá 5511999993210\nGastão\n{{3}}\nQuiz Isabella')
  assert.deepEqual(unresolvedTemplateVariableKeys(renderTemplateVariableTextStrict(body, variables, lead)), ['3'])
  assert.equal(getAvailableVariableSources([lead]).some(source => source.token === '{cpf}'), false)
  assert.equal(getAvailableVariableSources([lead]).some(source => source.token === '{produto}'), true)
})

test('interface mostra o motivo e consulta o estado real do lote', () => {
  assert.match(leadsPage, /dispatchValidationMessage/)
  assert.match(leadsPage, /dispatchRecipientLabel/)
  assert.match(leadsPage, /dispatchStatus\.deliveryStatus === 'delivered'/)
  assert.match(leadsPage, /\/api\/leads\/dispatch\/\$\{dispatchStatus\.batchId\}/)
  assert.match(statusRoute, /deliveryStatus/)
  assert.match(statusRoute, /partial_failure/)
  assert.match(dispatchRoute, /renderTemplateVariableTextStrict/)
  assert.match(dispatchRoute, /não foi resolvida para todos os destinatários/)
})

test('worker bloqueia variáveis vazias antes da chamada Meta', () => {
  const cronSource = readFileSync(resolve(process.cwd(), 'src/app/api/cron/route.ts'), 'utf8')
  assert.match(cronSource, /não foi resolvida antes da chamada à Meta/)
  assert.match(cronSource, /!value\.trim\(\)/)
})
