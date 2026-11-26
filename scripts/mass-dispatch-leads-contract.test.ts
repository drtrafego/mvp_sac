import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  getAvailableVariableSources,
  renderTemplateVariableTextStrict,
  unresolvedTemplateVariableKeys,
} from '../src/lib/lead-template-variables'
import { summarizeDispatchEligibility } from '../src/lib/mass-dispatch-eligibility'

const leadsPage = readFileSync(resolve(process.cwd(), 'src/app/(dashboard)/leads/page.tsx'), 'utf8')
const dispatchRoute = readFileSync(resolve(process.cwd(), 'src/app/api/leads/dispatch/route.ts'), 'utf8')
const queueSource = readFileSync(resolve(process.cwd(), 'src/lib/mass-dispatch.ts'), 'utf8')
const statusRoute = readFileSync(resolve(process.cwd(), 'src/app/api/leads/dispatch/[batchId]/route.ts'), 'utf8')
const validationRoute = readFileSync(resolve(process.cwd(), 'src/app/api/leads/dispatch/validate/route.ts'), 'utf8')

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
  assert.match(dispatchRoute, /runDispatchCron\(workerRequest\)/)
  assert.match(dispatchRoute, /batch_id=\$\{batch\.id\}/)
  assert.match(dispatchRoute, /workerTriggered/)
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
  assert.match(statusRoute, /confirmedAt/)
  assert.match(dispatchRoute, /renderTemplateVariableTextStrict/)
  assert.match(dispatchRoute, /não foi resolvida para todos os destinatários/)
})

test('modal vira recibo após confirmação e não mantém CTA de reenvio', () => {
  assert.match(leadsPage, /if \(dispatchStatus \|\| dispatchEligibilityLoading/)
  assert.match(leadsPage, /dispatchStatus \? 'Recibo do disparo'/)
  assert.match(leadsPage, /O envio foi confirmado; este formulário está encerrado para evitar reenvio/)
  assert.match(leadsPage, /Abrir histórico/)
  assert.match(leadsPage, /<Button variant="outline" onClick=\{\(\) => setDispatchOpen\(false\)\}>Fechar<\/Button>/)
  assert.match(leadsPage, /!dispatchStatus && <TemplateSelector/)
  assert.match(leadsPage, /!dispatchStatus && <>/)
})

test('seleção nova é validada por contagem e nunca permite disparo parcial', () => {
  assert.match(leadsPage, /openDispatchForSelection/)
  assert.match(leadsPage, /setDispatchStatus\(null\)/)
  assert.match(leadsPage, /dispatchEligibility\.eligibleCount !== dispatchEligibility\.uniqueRequestedCount/)
  assert.match(leadsPage, /Nenhum envio parcial será permitido/)
  assert.match(leadsPage, /\/api\/leads\/dispatch\/validate\?\$\{params\}/)
  assert.match(validationRoute, /GET\(request: NextRequest\)/)
  assert.match(validationRoute, /summarizeDispatchEligibility/)
  assert.match(validationRoute, /eq\(recoveryLeads\.companyId, company\.id\)/)
  assert.match(validationRoute, /requirePhone: false/)
  assert.match(dispatchRoute, /Nenhum destinatário foi enfileirado/)
  assert.match(dispatchRoute, /missingCount/)
})

test('resumo da seleção separa IDs ausentes, sem telefone e duplicados sem expor PII', () => {
  assert.deepEqual(summarizeDispatchEligibility([10, 11, 11, 12], [
    { id: 10, phone: '5511999990000' },
    { id: 11, phone: '' },
  ]), {
    requestedCount: 4,
    uniqueRequestedCount: 3,
    duplicateCount: 1,
    eligibleCount: 1,
    missingCount: 1,
    noPhoneCount: 1,
  })
})

test('worker bloqueia variáveis vazias antes da chamada Meta', () => {
  const cronSource = readFileSync(resolve(process.cwd(), 'src/app/api/cron/route.ts'), 'utf8')
  assert.match(cronSource, /não foi resolvida antes da chamada à Meta/)
  assert.match(cronSource, /!value\.trim\(\)/)
  assert.match(cronSource, /targetBatchId/)
  assert.match(cronSource, /messageJobs\.massDispatchBatchId, targetBatchId/)
})
