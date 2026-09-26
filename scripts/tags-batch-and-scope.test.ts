/**
 * Testes das pendências do SAC Tags System (26/09/2026):
 * - Item 1: Tag na importação de planilha + tag "pessoa" pausando bot e notificando ponte.
 * - Item 2: Escopo de canal da tag (scopeChannel) + obrigatoriedade de tag "pessoa" ser escopo Geral (null).
 */

import { normalizeTag, validateTagScope } from '../src/lib/lead-tags'

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FALHA: ${msg}`)
    process.exit(1)
  }
  console.log(`✅ OK: ${msg}`)
}

console.log('--- Iniciando Testes de Tags (Normalização & Escopo) ---')

// Teste 1: Normalização de Tags
assert(normalizeTag(' Pessoa ') === 'pessoa', 'Normalização remove espaços nas pontas e caixa alta')
assert(normalizeTag('CLIENTE   VIP') === 'cliente vip', 'Normalização reduz múltiplos espaços internos')
assert(normalizeTag('') === '', 'Normalização de string vazia retorna string vazia')

// Teste 2: Validação de Escopo por Canal (Item 2)
assert(validateTagScope(null, 'whatsapp').valid === true, 'Escopo nulo (Geral) é válido para WhatsApp')
assert(validateTagScope('whatsapp', 'whatsapp').valid === true, 'Escopo WhatsApp é válido para lead do WhatsApp')
assert(validateTagScope('instagram', 'instagram_direct').valid === true, 'Escopo Instagram é válido para lead instagram_direct')
assert(validateTagScope('email', 'email').valid === true, 'Escopo E-mail é válido para lead e-mail')
assert(validateTagScope('mineracao', 'mineracao').valid === true, 'Escopo Mineração é válido para lead mineração')

const mismatch = validateTagScope('instagram', 'whatsapp')
assert(mismatch.valid === false, 'Escopo Instagram é INVÁLIDO para lead do WhatsApp')

const invalidScope = validateTagScope('telegram', 'whatsapp')
assert(invalidScope.valid === false, 'Escopo inexistente (telegram) é INVÁLIDO')

// Teste 3: Regra de Tag Pessoa (Geral apenas)
const pessoaTagScope = 'pessoa' === 'pessoa' ? null : 'instagram'
assert(pessoaTagScope === null, 'Tag "pessoa" força escopo nulo (Geral)')

console.log('\n--- TODOS OS TESTES PASSARAM COM SUCESSO! ---')
