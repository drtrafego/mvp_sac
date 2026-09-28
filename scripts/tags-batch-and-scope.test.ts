import { validateTagScope, PESSOA_TAG, normalizeTag } from '../src/lib/lead-tags'

function runTests() {
  console.log('🧪 Executando testes unitários e de integração para Tags System (Item 1 & Item 2)...')
  let passed = 0
  let failed = 0

  function assert(condition: boolean, description: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${description}`)
      passed++
    } else {
      console.error(`  ❌ FAIL: ${description}`)
      failed++
    }
  }

  // 1. Tag normalisation
  assert(normalizeTag('  Pessoa  ') === 'pessoa', 'Normaliza "  Pessoa  " para "pessoa"')
  assert(normalizeTag('CLIENTE_VIP') === 'cliente_vip', 'Normaliza "CLIENTE_VIP" para "cliente_vip"')

  // 2. Tag "pessoa" força escopo NULL
  const pessoaResult = validateTagScope('pessoa', 'whatsapp', 'whatsapp')
  assert(pessoaResult.ok && pessoaResult.scopeChannel === null, 'Tag "pessoa" força scopeChannel = null mesmo se "whatsapp" for informado')

  // 3. Validação de escopos válidos
  const waResult = validateTagScope('vip', 'whatsapp', 'whatsapp')
  assert(waResult.ok && waResult.scopeChannel === 'whatsapp', 'Aceita escopo whatsapp compatível com canal do lead')

  const igResult = validateTagScope('vip', 'instagram', 'instagram')
  assert(igResult.ok && igResult.scopeChannel === 'instagram', 'Aceita escopo instagram compatível com canal do lead')

  const generalResult = validateTagScope('frio', null, 'whatsapp')
  assert(generalResult.ok && generalResult.scopeChannel === null, 'Aceita tag geral (null scope)')

  // 4. Validação de escopo inválido
  const invalidResult = validateTagScope('vip', 'telegram', 'whatsapp')
  assert(!invalidResult.ok && invalidResult.error?.includes('inválido'), 'Rejeita escopo "telegram" não cadastrado')

  // 5. Incompatibilidade com canal do lead
  const mismatchResult = validateTagScope('vip', 'instagram', 'whatsapp')
  assert(!mismatchResult.ok && mismatchResult.error?.includes('incompatível'), 'Rejeita escopo "instagram" em lead do canal "whatsapp"')

  console.log(`\nResultado dos testes: ${passed} passaram, ${failed} falharam.`)
  if (failed > 0) process.exit(1)
}

runTests()
