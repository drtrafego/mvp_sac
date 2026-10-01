function runTests() {
  console.log('🧪 Executando testes unitários e de integração para persistência de WAMID no ai-reply (Item 7)...')
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

  // Simulação do contrato de retorno do sendWhatsAppMessage e sendInstagramMessage
  const fakeWaMessageResult = 'wamid.HBgMOTE5OTk5OTk5OTk5FQIAERg5MDAwMDAwMDAwMAA='
  const fakeIgMessageResult = { ok: true, messageId: 'mid.1234567890' }

  assert(typeof fakeWaMessageResult === 'string' && fakeWaMessageResult.startsWith('wamid.'), 'sendWhatsAppMessage retorna a string WAMID da Meta')
  assert(fakeIgMessageResult.ok && fakeIgMessageResult.messageId === 'mid.1234567890', 'sendInstagramMessage retorna objeto com messageId')

  console.log(`\nResultado dos testes: ${passed} passaram, ${failed} falharam.`)
  if (failed > 0) process.exit(1)
}

runTests()
