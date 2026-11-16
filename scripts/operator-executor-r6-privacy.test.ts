import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactOperatorText } from '../src/lib/operator/privacy'

const recusados = [
  ['lead', 'Crie regra palavra "CADERNO" lead "PROSPECTO_X"'],
  ['cliente', 'Crie regra palavra "CADERNO" cliente "CLIENTE_X"'],
  ['palavra', 'Crie regra palavra "CADERNO"'],
  ['etapa', 'Crie regra palavra "CADERNO" etapa "Qualificados"'],
  ['citação única', 'Crie regra palavra "CADERNO" "agendar chamada hoje amanhã"'],
  ['segunda frase', 'Crie regra palavra "CADERNO" "Primeira" e "Segunda"'],
  ['observação simples', 'observação: "agendar chamada hoje amanhã"'],
  ['observação', 'observação: mensagem: "agendar chamada hoje amanhã"'],
  ['nota', 'nota: mensagem: "agendar chamada hoje amanhã"'],
  ['frase', 'A frase menciona mensagem: "agendar chamada hoje amanhã"'],
  ['frase após regra', 'Crie regra palavra CADERNO, alguém escreveu mensagem: "agendar chamada hoje amanhã"'],
  ['rótulo citado', 'Crie regra palavra "mensagem: agendar chamada hoje amanhã"'],
  ['homóglifo', 'mеnsagem: "agendar chamada hoje amanhã"'],
  ['zero-width', 'men\u200bsagem: "agendar chamada hoje amanhã"'],
  ['fullwidth', 'ｍｅｎｓａｇｅｍ: "agendar chamada hoje amanhã"'],
  ['prefixo de rótulo', 'antimensagem: "agendar chamada hoje amanhã"'],
  ['vazio', 'mensagem: ""'],
  ['espaços', 'mensagem: "  "'],
  ['parágrafo vazio', 'mensagem:\n\nagendar chamada hoje amanhã'],
  ['aspas desbalanceadas', 'mensagem: "agendar chamada hoje amanhã'],
  ['aspas incompatíveis', 'mensagem: “agendar chamada hoje amanhã»'],
  ['aninhadas sem escape', 'mensagem: "agendar "chamada" hoje amanhã"'],
  ['duas DM', 'mensagem: "agendar chamada hoje amanhã"\ndm: "mover etapa hoje"'],
  ['duas DM sem comando', 'mensagem: "DM_A" mensagem: "DM_B"'],
  ['duas DM inline', 'Crie regra palavra "CADERNO" mensagem: "agendar chamada hoje amanhã" mensagem: "mover etapa hoje"'],
  ['duas legadas', 'mensagem "Olá" mensagem "Tchau"'],
  ['duas sem aspas', 'mensagem: agendar chamada hoje amanhã mensagem: mover etapa hoje'],
  ['duas idênticas', 'mensagem: "agendar chamada hoje amanhã"\ntexto: "agendar chamada hoje amanhã"'],
  ['1501', 'mensagem: "' + 'á'.repeat(1501) + '"'],
  ['controle', 'mensagem: "agendar\x01chamada"'],
]
for (const [nome, pedido] of recusados) test(`R6 extração recusa ${nome}`, () => {
  const result = redactOperatorText(pedido)
  assert.equal(result.markers.has('[DM_1]'), false)
  assert.ok(!result.text.includes('[DM_1]'))
})
const aceitos = [
  ...['mensagem', 'texto', 'dm', 'resposta', 'responder', 'responda', 'enviar', 'envie', 'mandar', 'mande', 'MENSAGEM'].flatMap(label => ['', ':'].map(colon => [label + colon, `${label}${colon} "agendar chamada hoje amanhã"`, 'agendar chamada hoje amanhã'])),
  ['palavras de intenção na DM', 'mensagem: Receba este texto completo e envie mensagem amanhã.', 'Receba este texto completo e envie mensagem amanhã.'],
  ['legado inline', 'Crie regra palavra CADERNO mensagem agendar chamada hoje amanhã', 'agendar chamada hoje amanhã'],
  ['CRLF', 'mensagem:\r\nOlá\r\nmaterial\r\n\r\nFim.', 'Olá\r\nmaterial'],
  ['espaços exatos', 'mensagem: "  Olá!  "', '  Olá!  '],
  ['NFD', 'mensagem: "Olá, ação"'.normalize('NFD'), 'Olá, ação'.normalize('NFD')],
  ['NFC', 'mensagem: "Olá, ação"'.normalize('NFC'), 'Olá, ação'.normalize('NFC')],
  ['emoji markdown', 'mensagem: "**Olá** 📚 [material](https://example.test)"', '**Olá** 📚 [material](https://example.test)'],
  ['rótulo dentro da DM', 'mensagem: "Peça assim: mensagem: Olá"', 'Peça assim: mensagem: Olá'],
  ['homóglifo dentro da DM', 'mensagem: "Olá, rеtire"', 'Olá, rеtire'],
  ['zero-width dentro da DM', 'mensagem: "Olá, re\u200btire"', 'Olá, re\u200btire'],
  ['aspas escapadas', String.raw`mensagem: "Diga \"quero\" agora"`, 'Diga "quero" agora'],
  ['aspas na linha seguinte', 'mensagem:\r\n  “Olá!\r\nMaterial 📚”', 'Olá!\r\nMaterial 📚'],
  ['aspas tipográficas aninhadas', 'mensagem: “Diga “quero” agora”', 'Diga “quero” agora'],
  ['aspas diferentes', 'mensagem: “Diga «quero» agora”', 'Diga «quero» agora'],
  ['marcador literal no conteúdo', 'mensagem: "[LINK_99] [DM_2]"', '[LINK_99] [DM_2]'],
  ['1500', 'mensagem: "' + 'á'.repeat(1500) + '"', 'á'.repeat(1500)],
]
for (const [nome, pedido, esperado] of aceitos) test(`R6 extração aceita ${nome} sem expor conteúdo`, () => {
  const result = redactOperatorText(pedido)
  assert.equal(result.markers.get('[DM_1]'), esperado)
  assert.match(result.text, /\[DM_1\]/)
  assert.ok(!result.text.includes(esperado))
  assert.equal([...result.markers.values()].filter(value => value === esperado).length, 1)
})
test('R6 não compartilha a DM entre pedidos', () => {
  const a = redactOperatorText('mensagem: "Privado do primeiro"')
  const b = redactOperatorText('mensagem: "Privado do segundo"')
  const c = redactOperatorText('Crie regra palavra "CADERNO"')
  assert.equal(a.markers.get('[DM_1]'), 'Privado do primeiro')
  assert.equal(b.markers.get('[DM_1]'), 'Privado do segundo')
  assert.equal(c.markers.get('[DM_1]'), undefined)
})
test('R6 mensagens inválidas e ambíguas não expõem sequer vocabulário permitido', () => {
  for (const pedido of ['mensagem: "agendar "chamada" hoje amanhã"', 'Crie regra palavra "CADERNO" "observação sem fechar\nmensagem: agendar chamada hoje amanhã', 'mensagem: "agendar chamada hoje amanhã"\ndm: "mover etapa hoje"', 'mensagem: "' + 'agendar '.repeat(220) + '"']) {
    const result = redactOperatorText(pedido)
    assert.doesNotMatch(result.text, /agendar|chamada|mover|etapa/)
  }
})
