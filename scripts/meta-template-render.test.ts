import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderMetaTemplate } from '../src/lib/meta-template-utils'

test('renderiza no histórico o template inteiro com variáveis, rodapé e botões', () => {
  const rendered = renderMetaTemplate([
    { type: 'HEADER', format: 'TEXT', text: 'Olá {{1}}' },
    {
      type: 'BODY',
      text: 'Seu cadastro foi recebido, {{1}}.\n\nProduto: {{2}}.\n\nPedido: {{3}}.\n\nAcompanhe pelo código {{4}}.',
    },
    { type: 'FOOTER', text: 'Equipe de atendimento' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'QUICK_REPLY', text: 'Falar com a equipe' },
        { type: 'URL', text: 'Abrir pedido', url: 'https://exemplo.com/pedido' },
      ],
    },
  ], ['Gastão', 'Curso', '12345', 'ABC-9'])

  assert.deepEqual(rendered, {
    complete: true,
    content: [
      'Olá Gastão',
      'Seu cadastro foi recebido, Gastão.\n\nProduto: Curso.\n\nPedido: 12345.\n\nAcompanhe pelo código ABC-9.',
      'Equipe de atendimento',
      'Falar com a equipe',
      'Abrir pedido',
    ].join('\n\n'),
  })
})

test('não afirma conteúdo completo quando o cabeçalho é mídia', () => {
  assert.deepEqual(renderMetaTemplate([
    { type: 'HEADER', format: 'IMAGE' },
    { type: 'BODY', text: 'Olá {{1}}' },
  ], ['Gastão']), { complete: false, content: '' })
})
