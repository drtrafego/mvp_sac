import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateTemplateHeaderDocument } from '../src/lib/dispatch-document-form'

test('HEADER DOCUMENT exige link público https e nome de arquivo válido', () => {
  const invalid = validateTemplateHeaderDocument({
    link: 'http://localhost/material.pdf',
    filename: '../Material.pdf',
  }, true)

  assert.equal(invalid.isValid, false)
  assert.match(invalid.linkError ?? '', /https público/)
  assert.match(invalid.filenameError ?? '', /nome de arquivo válido/)
})

test('HEADER DOCUMENT aceita e normaliza um PDF público', () => {
  const result = validateTemplateHeaderDocument({
    link: ' https://cdn.exemplo.com/materiais/itero.pdf ',
    filename: ' Material Itero.pdf ',
  }, true)

  assert.deepEqual(result, {
    isValid: true,
    value: {
      link: 'https://cdn.exemplo.com/materiais/itero.pdf',
      filename: 'Material Itero.pdf',
    },
    linkError: null,
    filenameError: null,
  })
})

test('template sem HEADER DOCUMENT não exige campos de documento', () => {
  const result = validateTemplateHeaderDocument({ link: '', filename: '' }, false)

  assert.deepEqual(result, { isValid: true, linkError: null, filenameError: null })
})

test('quebra de linha no fim do nome ou do link é recusada (igual ao servidor)', () => {
  assert.equal(validateTemplateHeaderDocument({ link: 'https://example.com/a.pdf', filename: 'Material.pdf\n' }, true).isValid, false)
  assert.equal(validateTemplateHeaderDocument({ link: 'https://example.com/a.pdf\n', filename: 'Material.pdf' }, true).isValid, false)
  assert.equal(validateTemplateHeaderDocument({ link: 'https://example.com/a.pdf', filename: 'Material.pdf' }, true).isValid, true)
})
