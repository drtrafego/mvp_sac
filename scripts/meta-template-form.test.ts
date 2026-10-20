import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formToMetaTemplateComponents } from '../src/lib/meta-template-form'
import { validateMetaTemplateComponents } from '../src/lib/meta-template-validation'

test('formulário visual monta o payload Meta com variáveis, mídia e botões', () => {
  const components = formToMetaTemplateComponents({
    body: 'Olá {{1}}, sua consulta é {{2}}.',
    bodyExamples: 'Gastão, amanhã às 14h',
    headerType: 'image',
    headerText: '',
    headerExample: 'media-handle-123',
    footer: 'Equipe de atendimento',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Confirmar', value: '' },
      { type: 'URL', text: 'Ver agenda', value: 'https://exemplo.com/agenda' },
      { type: 'PHONE_NUMBER', text: 'Ligar', value: '+5511999999999' },
    ],
  })

  assert.deepEqual(components, [
    { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['media-handle-123'] } },
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

test('formulário exige exemplos suficientes para as variáveis e mídia de cabeçalho', () => {
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
    body: 'Olá',
    bodyExamples: '',
    headerType: 'video',
    headerText: '',
    headerExample: '',
    footer: '',
    buttons: [],
  }), /identificador de mídia/)
})

test('tela expõe controles visuais e não expõe editor JSON', () => {
  const source = readFileSync(path.resolve(__dirname, '../src/components/meta/template-manager.tsx'), 'utf8')
  assert.match(source, /Corpo da mensagem/)
  assert.match(source, /Cabeçalho, opcional/)
  assert.match(source, /Botões, opcional/)
  assert.doesNotMatch(source, /Componentes Meta, JSON/)
  assert.doesNotMatch(source, /JSON\.parse/)
})
