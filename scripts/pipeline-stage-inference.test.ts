import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferPipelineStage } from '../src/lib/pipeline-stage'

// Regressao do bug real medido na Isabela Fanini (company_id=2): a API
// /api/v1/companies/[idOrSlug]/pipeline tinha sua PROPRIA copia da regra de
// inferencia de etapa (`l.pipelineStage || 'novo_contato'`), sem o fallback
// por eventType/status que a pagina do Kanban ja tinha. Resultado real em
// producao: 100% dos 82 leads da empresa tinham pipeline_stage nulo, e essa
// API jogava TODOS (inclusive as 51 compras aprovadas) em "novo_contato" em
// vez de "fechado". Este teste trava a regra UNICA em src/lib/pipeline-stage.ts
// pra nunca mais divergir entre os dois lugares que a usam.

function main() {
  test('pipeline_stage explicito sempre vence (edicao manual do usuario)', () => {
    assert.equal(inferPipelineStage({ pipelineStage: 'qualificado', eventType: 'compra_aprovada' }), 'qualificado')
  })

  test('compra_aprovada sem pipeline_stage vira fechado (bug real: virava novo_contato)', () => {
    assert.equal(inferPipelineStage({ pipelineStage: null, eventType: 'compra_aprovada', status: 'completed' }), 'fechado')
  })

  test('status converted sem pipeline_stage tambem vira fechado', () => {
    assert.equal(inferPipelineStage({ pipelineStage: null, status: 'converted', eventType: 'atendimento_ia' }), 'fechado')
  })

  test('em_atendimento vem do status in_progress', () => {
    assert.equal(inferPipelineStage({ pipelineStage: null, status: 'in_progress', eventType: 'atendimento_ia' }), 'em_atendimento')
  })

  test('pix e boleto sem pipeline_stage viram qualificado', () => {
    assert.equal(inferPipelineStage({ pipelineStage: null, eventType: 'pix' }), 'qualificado')
    assert.equal(inferPipelineStage({ pipelineStage: null, eventType: 'boleto' }), 'qualificado')
  })

  test('prioridade alta sem outro sinal vira agendado', () => {
    assert.equal(inferPipelineStage({ pipelineStage: null, eventType: 'carrinho_abandonado', priority: 2 }), 'agendado')
  })

  test('sem nenhum sinal cai no default novo_contato (ex.: carrinho_abandonado sem prioridade)', () => {
    assert.equal(inferPipelineStage({ pipelineStage: null, eventType: 'carrinho_abandonado', priority: 1 }), 'novo_contato')
  })

  console.log('\nOK: pipeline-stage-inference passou.')
}

main()
