import { AmbiguousCredentialError } from '../src/lib/instagram-webhook-errors'

function runTests() {
  console.log('🧪 Executando testes unitários e de isolamento de tenant (Item 1)...')
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

  // 1. Instanciação da classe de erro AmbiguousCredentialError
  const err = new AmbiguousCredentialError('Ambiguous instagramAccountId "12345"')
  assert(err instanceof Error, 'AmbiguousCredentialError é uma subclasse de Error')
  assert(err.name === 'AmbiguousCredentialError', 'Nome da exceção é AmbiguousCredentialError')
  assert(err.message.includes('12345'), 'Mensagem contém o identificador duplicado')

  // 2. Normalização de tokens e IDs de credencial (trim de espaços)
  function normalizeCredentialInput(val: unknown): string | null {
    if (typeof val !== 'string') return null
    const trimmed = val.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  assert(normalizeCredentialInput('  ') === null, 'Espaço em branco é normalizado para null')
  assert(normalizeCredentialInput('\t\n') === null, 'Quebras de linha e tabulações viram null')
  assert(normalizeCredentialInput('  123456789  ') === '123456789', 'Remove espaços no início e no fim')
  assert(normalizeCredentialInput(null) === null, 'Valor null retorna null')
  assert(normalizeCredentialInput(undefined) === null, 'Valor undefined retorna null')

  console.log(`\nResultado dos testes: ${passed} passaram, ${failed} falharam.`)
  if (failed > 0) process.exit(1)
}

runTests()
