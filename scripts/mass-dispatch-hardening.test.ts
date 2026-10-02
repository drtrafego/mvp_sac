import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBrazilianPhone } from '../src/lib/phone'
import {
  calculateDispatchSpacingMs,
  DEFAULT_DISPATCH_SPACING,
} from '../src/lib/message-jobs-policy'

test('Brecha 2: normalização de telefone unifica variações com e sem nono dígito e com zero de discagem', () => {
  const expected = '5511998765432'

  // Variações comuns em planilhas e webhooks
  assert.equal(formatBrazilianPhone('1198765432'), expected, 'DDD + 8 dígitos sem DDI deve receber 55 e nono dígito 9')
  assert.equal(formatBrazilianPhone('11998765432'), expected, 'DDD + 9 dígitos sem DDI deve receber 55')
  assert.equal(formatBrazilianPhone('551198765432'), expected, '55 + DDD + 8 dígitos deve receber nono dígito 9')
  assert.equal(formatBrazilianPhone('5511998765432'), expected, '55 + DDD + 9 dígitos deve ser preservado')
  assert.equal(formatBrazilianPhone('01198765432'), expected, 'Com zero à esquerda e 8 dígitos deve normalizar para 5511998765432')
  assert.equal(formatBrazilianPhone('011998765432'), expected, 'Com zero à esquerda e 9 dígitos deve normalizar para 5511998765432')
  assert.equal(formatBrazilianPhone('+55 (11) 9876-5432'), expected, 'Formatado com pontuação e 8 dígitos deve normalizar')
  assert.equal(formatBrazilianPhone('+55 (11) 99876-5432'), expected, 'Formatado com pontuação e 9 dígitos deve normalizar')

  // Número internacional não-55 deve ser preservado se tiver mais de 11 dígitos
  assert.equal(formatBrazilianPhone('+1 (555) 234-5678'), '15552345678', 'Internacional EUA')
})

test('Brecha 4b: espaçamento entre envios respeita min/max e desativa em ambiente de teste', () => {
  // Em ambiente de teste (NODE_ENV=test), o espaçamento retorna 0 para não atrasar a suíte
  const testSpacing = calculateDispatchSpacingMs(DEFAULT_DISPATCH_SPACING, () => 0.5, { NODE_ENV: 'test' })
  assert.equal(testSpacing, 0, 'Em teste deve ser 0ms')

  // Em produção, calcula entre minSeconds e maxSeconds em milissegundos
  const prodEnv = { NODE_ENV: 'production' }
  const minSpacing = calculateDispatchSpacingMs({ minSeconds: 1, maxSeconds: 3 }, () => 0, prodEnv)
  assert.equal(minSpacing, 1000, 'Com random 0 deve retornar minSeconds (1000ms)')

  const maxSpacing = calculateDispatchSpacingMs({ minSeconds: 1, maxSeconds: 3 }, () => 1, prodEnv)
  assert.equal(maxSpacing, 3000, 'Com random 1 deve retornar maxSeconds (3000ms)')

  const midSpacing = calculateDispatchSpacingMs({ minSeconds: 1, maxSeconds: 3 }, () => 0.5, prodEnv)
  assert.equal(midSpacing, 2000, 'Com random 0.5 deve retornar média (2000ms)')
})

test('Brecha 3 & 4a: verificação estática do SQL de dedup entre lotes e orçamento 24h completo', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const massDispatchSource = fs.readFileSync(path.resolve(__dirname, '../src/lib/mass-dispatch.ts'), 'utf8')
  const dispatchRouteSource = fs.readFileSync(path.resolve(__dirname, '../src/app/api/leads/import/[batchId]/dispatch/route.ts'), 'utf8')

  // Brecha 3: dedup entre lotes suprime leads com jobs pendentes ou em processamento
  assert.match(
    massDispatchSource,
    /NOT EXISTS\s*\(\s*SELECT 1 FROM message_jobs existing_job\s+WHERE existing_job\.lead_id = l\.id\s+AND existing_job\.mass_dispatch_batch_id IS NOT NULL\s+AND existing_job\.status IN \('pending', 'processing'\)/,
    'queueMassDispatchBatch deve suprimir leads com disparos pendentes/processing'
  )
  assert.match(
    dispatchRouteSource,
    /NOT EXISTS\s*\(\s*SELECT 1 FROM message_jobs existing_job\s+WHERE existing_job\.lead_id = l\.id\s+AND existing_job\.mass_dispatch_batch_id IS NOT NULL\s+AND existing_job\.status IN \('pending', 'processing'\)/,
    'loadPreview deve refletir a mesma supressão para o número de destinatários bater'
  )

  // Brecha 4a: orçamento inclui whatsapp_messages outbound e remove restrição exclusiva de batch_id
  assert.match(massDispatchSource, /queued_or_sent_jobs AS/, 'Deve contabilizar todos os jobs pendentes/processing/sent no orçamento')
  assert.match(massDispatchSource, /direct_sent_messages AS/, 'Deve contabilizar envios diretos de whatsapp_messages no orçamento')
  assert.match(massDispatchSource, /SELECT \(j\.cnt \+ m\.cnt\)::int AS reserved_count/, 'Deve somar jobs e envios diretos no mesmo contador de 24h')
})

test('Brecha 1: verificação do índice único e arbiter cobrindo import_planilha', async () => {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const schemaSource = fs.readFileSync(path.resolve(__dirname, '../src/lib/db/schema.ts'), 'utf8')
  const dbIndexSource = fs.readFileSync(path.resolve(__dirname, '../src/lib/db/index.ts'), 'utf8')
  const importRouteSource = fs.readFileSync(path.resolve(__dirname, '../src/app/api/leads/import/route.ts'), 'utf8')

  // Índice único deve cobrir import_planilha
  assert.match(
    schemaSource,
    /uniqueIndex\('recovery_leads_chat_company_phone_unique'\)[\s\S]*?'instagram',\s*'sac',\s*'hermes',\s*'import_planilha'/,
    'schema.ts deve incluir import_planilha no índice único'
  )

  // ensureSchema deve criar o índice com import_planilha
  assert.match(
    dbIndexSource,
    /WHERE platform IN \('instagram',\s*'sac',\s*'hermes',\s*'import_planilha'\)/,
    'ensureSchema deve incluir import_planilha'
  )

  // Rota de importação deve usar onConflictDoUpdate com o arbiter correspondente
  assert.match(
    importRouteSource,
    /\.onConflictDoUpdate\(\{[\s\S]*?targetWhere: sql`\$\{recoveryLeads\.platform\} in \('instagram', 'sac', 'hermes', 'import_planilha'\)`/,
    'import route deve usar onConflictDoUpdate com o predicado correto do índice'
  )
})
