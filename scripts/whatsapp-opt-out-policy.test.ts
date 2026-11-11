import assert from 'node:assert/strict'
import test from 'node:test'
import { isWhatsAppOptOutButtonLabel, isWhatsAppOptOutExactText, isWhatsAppOptOutText, isWhatsAppPossibleOptOutText } from '../src/lib/recovery-sequence-policy'
import { commercialPhrases, originalPolicy, reviewPhrases } from './whatsapp-opt-out-fixtures'

for (const phrase of ['Não receber mensagens', 'Nao receber mensagens', 'No recibir mensajes']) {
  test(`botão exige igualdade normalizada: ${phrase}`, () => {
    for (const variant of [phrase, phrase.normalize('NFD'), ` 🛑 ¡${phrase.toUpperCase().replace(/ /g, ' , \t\n ')}! `]) {
      assert.equal(isWhatsAppOptOutButtonLabel(variant), true, variant)
      assert.equal(isWhatsAppOptOutExactText(variant), false, 'rótulo não estende o detector de texto')
      assert.equal(isWhatsAppOptOutText(variant), false, 'rótulo não estende prefixos')
    }
    assert.equal(isWhatsAppOptOutButtonLabel(`${phrase} no meu site`), false)
    assert.equal(isWhatsAppOptOutButtonLabel(`exemplo ${phrase}`), false)
  })
}

for (const phrase of reviewPhrases) {
  test(`pedido exige apenas revisão: ${phrase}`, () => {
    assert.equal(isWhatsAppPossibleOptOutText(phrase), true)
    assert.equal(isWhatsAppPossibleOptOutText(` ¡${phrase.toUpperCase().normalize('NFD')}! `), true)
    assert.equal(isWhatsAppOptOutExactText(phrase), false)
  })
}

for (const phrase of commercialPhrases) {
  test(`anexo B não dispara detector exato, botão novo ou revisão: ${phrase}`, () => {
    assert.equal(isWhatsAppOptOutExactText(phrase), false)
    assert.equal(isWhatsAppOptOutButtonLabel(phrase), false)
    assert.equal(isWhatsAppPossibleOptOutText(phrase), false)
  })
}

test('Isabela mantém exatamente os resultados de origin/main, inclusive 8 falsos positivos preexistentes', () => {
  const original = originalPolicy()
  let existingFalsePositives = 0
  for (const phrase of [...commercialPhrases, ...reviewPhrases, 'stop por favor', 'STOP sending me messages']) {
    const before = original.isWhatsAppOptOutText(phrase)
    assert.equal(isWhatsAppOptOutText(phrase), before, phrase)
    assert.equal(isWhatsAppOptOutExactText(phrase), original.isWhatsAppOptOutExactText(phrase), phrase)
    if (commercialPhrases.includes(phrase)) {
      if (before) existingFalsePositives++
      console.log('BASE_ISABELA', JSON.stringify({ phrase, before, after: isWhatsAppOptOutText(phrase) }))
    }
  }
  assert.equal(existingFalsePositives, 8)
  console.log('COMPARACAO_ISABELA frases=58 diferenças=0 falsos_positivos_base=8 falsos_positivos_atual=8')
})

test('comandos anteriores permanecem válidos', () => {
  for (const phrase of ['pare', 'parar', 'stop', 'optout', 'opt out', 'sair', 'descadastrar', 'cancelar mensagens', 'cancelar mensagem', 'nao quero receber', 'nao me mande mais', 'nao enviar mais']) {
    assert.equal(isWhatsAppOptOutText(phrase), true)
    assert.equal(isWhatsAppOptOutExactText(phrase), true)
  }
  assert.equal(isWhatsAppOptOutText('stop por favor'), true)
  assert.equal(isWhatsAppOptOutText('STOP sending me messages'), true)
  assert.equal(isWhatsAppOptOutExactText('Sair do quarto até que horas?'), false)
})

test('entradas ausentes ou sem palavras não disparam detectores', () => {
  for (const phrase of [null, undefined, '', '  \t\n ', '!?…']) {
    for (const detect of [isWhatsAppOptOutText, isWhatsAppOptOutExactText, isWhatsAppOptOutButtonLabel, isWhatsAppPossibleOptOutText]) assert.equal(detect(phrase), false)
  }
})
