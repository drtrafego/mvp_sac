import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formToMetaTemplateComponents, templateVariableNumbers } from '../src/lib/meta-template-form'
import { validateMetaTemplateComponents } from '../src/lib/meta-template-validation'

test('formulário visual monta o payload Meta com variáveis, cabeçalho de texto e botões', () => {
  const components = formToMetaTemplateComponents({
    body: 'Olá {{1}}, sua consulta é {{2}}.',
    bodyExamples: 'Gastão, amanhã às 14h',
    headerType: 'text',
    headerText: 'Olá, {{1}}',
    headerExample: 'Gastão',
    footer: 'Equipe de atendimento',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Confirmar', value: '' },
      { type: 'URL', text: 'Ver agenda', value: 'https://exemplo.com/agenda' },
      { type: 'PHONE_NUMBER', text: 'Ligar', value: '+5511999999999' },
    ],
  })

  assert.deepEqual(components, [
    { type: 'HEADER', format: 'TEXT', text: 'Olá, {{1}}', example: { header_text: ['Gastão'] } },
    { type: 'BODY', text: 'Olá {{1}}, sua consulta é {{2}}.', example: { body_text: [['Gastão', 'amanhã às 14h']] } },
    { type: 'FOOTER', text: 'Equipe de atendimento' },
    { type: 'BUTTONS', buttons: [
      { type: 'QUICK_REPLY', text: 'Confirmar' },
      { type: 'URL', text: 'Ver agenda', url: 'https://exemplo.com/agenda' },
      { type: 'PHONE_NUMBER', text: 'Ligar', phone_number: '+5511999999999' },
    ] },
  ])
  assert.deepEqual(validateMetaTemplateComponents(components), components)
})

test('formulário exige exemplos suficientes para as variáveis', () => {
  assert.throws(() => formToMetaTemplateComponents({
    body: 'Olá {{1}} e {{2}}',
    bodyExamples: 'Gastão',
    headerType: 'none',
    headerText: '',
    headerExample: '',
    footer: '',
    buttons: [],
  }), /Informe 2 exemplo/)
  assert.throws(() => formToMetaTemplateComponents({
    body: 'Olá {{2}}', bodyExamples: 'Gastão', headerType: 'none', headerText: '', headerExample: '', footer: '', buttons: [],
  }), /variáveis sequenciais/)
  assert.throws(() => formToMetaTemplateComponents({
    body: 'Olá', bodyExamples: '', headerType: 'none', headerText: '', headerExample: '', footer: '',
    buttons: [{ type: 'URL', text: 'Abrir', value: 'ftp://exemplo.com' }],
  }), /URL HTTP\(S\) válida/)
  assert.throws(() => formToMetaTemplateComponents({
    body: 'Olá', bodyExamples: '', headerType: 'none', headerText: '', headerExample: '', footer: '',
    buttons: [{ type: 'PHONE_NUMBER', text: 'Ligar', value: '(11) 99999-9999' }],
  }), /E\.164/)
})

test('identifica cada espaço variável uma única vez e em ordem', () => {
  assert.deepEqual(templateVariableNumbers('Olá {{2}}, {{1}} e {{2}}.'), [1, 2])
})

test('tela expõe controles visuais e não expõe editor JSON', () => {
  const source = readFileSync(path.resolve(__dirname, '../src/components/meta/template-manager.tsx'), 'utf8')
  assert.match(source, /Corpo da mensagem/)
  assert.match(source, /Cabeçalho, opcional/)
  assert.match(source, /Botões, opcional/)
  assert.match(source, /Cabeçalhos de mídia estarão disponíveis/)
  assert.match(source, /O que entra em \{\{/)
  assert.match(source, /não é enviado ao cliente/)
  assert.doesNotMatch(source, /separado por vírgula/)
  assert.doesNotMatch(source, /Componentes Meta, JSON/)
  assert.doesNotMatch(source, /JSON\.parse/)
  assert.doesNotMatch(source, /<option value="image">/)
  assert.doesNotMatch(source, /<option value="video">/)
  assert.doesNotMatch(source, /<option value="document">/)
  assert.doesNotMatch(source, /handle recebido no upload/)
})
