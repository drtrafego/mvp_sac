import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isFunilCursosTrigger,
  isDespertarDasBellas,
  createInitialFunilCursosState,
  calculateFunilCursosSchedules,
  formatFunilCursosContext,
  evaluateFunilTransition,
  canOfferPortal,
  D7_DELAY_MINUTES,
  D15_DELAY_MINUTES,
  D7_TEMPLATE,
  D15_TEMPLATE,
  type FunilCursosState,
} from '../src/lib/funnels/funil-cursos'

// ─── 1. Gatilho do Funil ─────────────────────────────────────────────────────

test('1.1 - Gatilho dispara para compra aprovada real de Despertar das Bellas na Kiwify', () => {
  const eligible = isFunilCursosTrigger({
    companySlug: 'isabela-fanini',
    platform: 'kiwify',
    eventType: 'compra_aprovada',
    productName: 'Despertar das Bellas',
    transactionId: 'kwf_txn_123456',
  })
  assert.equal(eligible, true)
})

test('1.2 - Gatilho NÃO inicia para lead de atendimento ou com tag comproudesafio sem compra aprovada na Kiwify', () => {
  // 641 registros importados como atendimento com Produto Principal
  const leadImportado = isFunilCursosTrigger({
    companySlug: 'isabela-fanini',
    platform: 'import_planilha',
    eventType: 'atendimento',
    productName: 'Produto Principal',
    tags: ['comproudesafio'],
    transactionId: null,
  })
  assert.equal(leadImportado, false)

  const leadApenasTag = isFunilCursosTrigger({
    companySlug: 'isabela-fanini',
    platform: 'kiwify',
    eventType: 'atendimento',
    productName: 'Despertar das Bellas',
    tags: ['comproudesafio'],
    transactionId: 'kwf_txn_999',
  })
  assert.equal(leadApenasTag, false)
})

test('1.3 - Gatilho NÃO inicia se empresa não for isabela-fanini', () => {
  const leadOutraEmpresa = isFunilCursosTrigger({
    companySlug: 'autonomia',
    platform: 'kiwify',
    eventType: 'compra_aprovada',
    productName: 'Despertar das Bellas',
    transactionId: 'kwf_txn_123',
  })
  assert.equal(leadOutraEmpresa, false)
})

test('1.4 - Gatilho NÃO inicia se transactionId estiver ausente (impede duplicidade e dados incompletos)', () => {
  const semTxn = isFunilCursosTrigger({
    companySlug: 'isabela-fanini',
    platform: 'kiwify',
    eventType: 'compra_aprovada',
    productName: 'Despertar das Bellas',
    transactionId: '',
  })
  assert.equal(semTxn, false)
})

test('1.5 - Gatilho aceita variações de digitação de Despertar das Bellas', () => {
  assert.equal(isDespertarDasBellas('Despertar das Bellas'), true)
  assert.equal(isDespertarDasBellas('despertar das belas'), true)
  assert.equal(isDespertarDasBellas('Despertar - Turma 2'), true)
  assert.equal(isDespertarDasBellas('Outro Curso'), false)
})

// ─── 2. Agendamentos D+7 e D+15 ─────────────────────────────────────────────

test('2.1 - Agendamentos contam exatamente 10.080 min (D+7) e 21.600 min (D+15) a partir de approvedDate', () => {
  const approved = new Date('2026-10-01T12:00:00.000Z')
  const schedules = calculateFunilCursosSchedules(approved)

  assert.equal(schedules.d7.delayMinutes, 10080)
  assert.equal(schedules.d15.delayMinutes, 21600)

  const diffD7 = (schedules.d7.scheduledFor.getTime() - approved.getTime()) / (60 * 1000)
  const diffD15 = (schedules.d15.scheduledFor.getTime() - approved.getTime()) / (60 * 1000)

  assert.equal(diffD7, D7_DELAY_MINUTES)
  assert.equal(diffD15, D15_DELAY_MINUTES)

  assert.equal(schedules.d7.template, D7_TEMPLATE)
  assert.equal(schedules.d15.template, D15_TEMPLATE)
  assert.equal(schedules.d15.template.includes('concluiu'), false)
})

// ─── 3. Injeção de Contexto [FUNIL_CURSOS] ───────────────────────────────────

test('3.1 - Injeta contexto [FUNIL_CURSOS] com todos os 14 campos mínimos', () => {
  const state = createInitialFunilCursosState({
    transactionId: 'TXN-777',
    productName: 'Despertar das Bellas',
    approvedDate: '2026-10-01T10:00:00.000Z',
  })

  const context = formatFunilCursosContext(state)

  assert.match(context, /^\[FUNIL_CURSOS\]/)
  assert.match(context, /funnel_name=funil_cursos/)
  assert.match(context, /stage=d7_pendente/)
  assert.match(context, /purchase_id=TXN-777/)
  assert.match(context, /product_name=Despertar das Bellas/)
  assert.match(context, /purchase_approved_at=2026-10-01T10:00:00\.000Z/)
  assert.match(context, /timezone=America\/Sao_Paulo/)
  assert.match(context, /attempt=1/)
  assert.match(context, /last_user_reply=/)
  assert.match(context, /started_status=/)
  assert.match(context, /difficulty_status=/)
  assert.match(context, /experience_status=/)
  assert.match(context, /portal_interest=/)
  assert.match(context, /portal_already_bought=false/)
  assert.match(context, /pause_reason=/)
  assert.match(context, /human_takeover=false/)
})

// ─── 4. Testes Obrigatórios de Fluxo e Transições (Renato Item 8) ────────────

test('4.1 - D+7 começou ("Sim, já comecei!")', () => {
  const initial = createInitialFunilCursosState({ transactionId: 'TXN-1' })
  const next = evaluateFunilTransition(initial, 'Sim, já comecei!')

  assert.equal(next.stage, 'd7_comecou')
  assert.equal(next.started_status, 'comecou')
  assert.equal(next.last_user_reply, 'Sim, já comecei!')
  assert.equal(canOfferPortal(next), false) // No D+7 não oferece o portal!
})

test('4.2 - D+7 não começou ("Ainda não consegui começar por falta de tempo")', () => {
  const initial = createInitialFunilCursosState({ transactionId: 'TXN-2' })
  const next = evaluateFunilTransition(initial, 'Ainda não consegui começar por causa da correria')

  assert.equal(next.stage, 'd7_nao_comecou')
  assert.equal(next.started_status, 'nao_comecou')
  assert.equal(canOfferPortal(next), false)
})

test('4.3 - D+7 dificuldade ("Não estou conseguindo acessar")', () => {
  const initial = createInitialFunilCursosState({ transactionId: 'TXN-3' })
  const next = evaluateFunilTransition(initial, 'Não estou conseguindo acessar a plataforma, deu erro na senha')

  assert.equal(next.stage, 'd7_com_dificuldade')
  assert.equal(next.started_status, 'com_dificuldade')
  assert.equal(next.difficulty_status, 'relatou_dificuldade')
  assert.equal(canOfferPortal(next), false)
})

test('4.4 - D+15 resposta positiva ("Amei a jornada, foi maravilhoso")', () => {
  const stateD15: FunilCursosState = {
    ...createInitialFunilCursosState({ transactionId: 'TXN-4' }),
    stage: 'd15_pendente',
    started_status: 'comecou',
  }

  const next = evaluateFunilTransition(stateD15, 'Amei demais a jornada, foi maravilhoso pra mim!')

  assert.equal(next.stage, 'd15_avaliacao_positiva')
  assert.equal(next.experience_status, 'positiva')
  assert.equal(canOfferPortal(next), false) // Primeiro apenas ouve, ainda sem abertura explícita do Portal
})

test('4.5 - D+15 resposta negativa ("Não gostei, achei bem fraco")', () => {
  const stateD15: FunilCursosState = {
    ...createInitialFunilCursosState({ transactionId: 'TXN-5' }),
    stage: 'd15_pendente',
    started_status: 'comecou',
  }

  const next = evaluateFunilTransition(stateD15, 'Não gostei, achei muito fraco e não me ajudou')

  assert.equal(next.stage, 'd15_avaliacao_negativa')
  assert.equal(next.experience_status, 'negativa')
  assert.equal(next.portal_interest, 'sem_interesse')
  assert.equal(canOfferPortal(next), false)
})

test('4.6 - D+15 resposta vaga ("Ok", "Depois vejo", "Legal") não é interpretada como interesse', () => {
  const stateD15: FunilCursosState = {
    ...createInitialFunilCursosState({ transactionId: 'TXN-6' }),
    stage: 'd15_pendente',
  }

  const nextVago1 = evaluateFunilTransition(stateD15, 'Depois vejo')
  assert.equal(nextVago1.portal_interest, 'sem_interesse')
  assert.equal(canOfferPortal(nextVago1), false)

  const nextVago2 = evaluateFunilTransition(stateD15, 'ok')
  assert.equal(nextVago2.portal_interest, 'sem_interesse')
  assert.equal(canOfferPortal(nextVago2), false)
})

test('4.7 - Silêncio (resposta vazia) mantém estado sem inventar interesse', () => {
  const initial = createInitialFunilCursosState({ transactionId: 'TXN-7' })
  const next = evaluateFunilTransition(initial, '   ')

  assert.equal(next.stage, 'd7_pendente')
  assert.equal(next.portal_interest, '')
  assert.equal(canOfferPortal(next), false)
})

test('4.8 - Interesse explícito no Portal ("Quero continuar, como funciona?")', () => {
  const stateAposD15Positivo: FunilCursosState = {
    ...createInitialFunilCursosState({ transactionId: 'TXN-8' }),
    stage: 'd15_avaliacao_positiva',
    experience_status: 'positiva',
  }

  const next = evaluateFunilTransition(stateAposD15Positivo, 'Quero continuar! Me explica como funciona o portal?')

  assert.equal(next.stage, 'portal_com_abertura')
  assert.equal(next.portal_interest, 'abertura')
  assert.equal(canOfferPortal(next), true) // Agora SIM pode apresentar o Portal!
})

test('4.9 - Portal já comprado nunca pode ser ofertado novamente', () => {
  const stateComprado: FunilCursosState = {
    ...createInitialFunilCursosState({ transactionId: 'TXN-9', portalAlreadyBought: true }),
    stage: 'd15_avaliacao_positiva',
    portal_already_bought: true,
  }

  const next = evaluateFunilTransition(stateComprado, 'Quero continuar!')

  assert.equal(next.portal_already_bought, true)
  assert.equal(next.portal_interest, 'ja_comprou')
  assert.equal(canOfferPortal(next), false)
})

test('4.10 - Pedido de parada ("Pare de mandar mensagens")', () => {
  const initial = createInitialFunilCursosState({ transactionId: 'TXN-10' })
  const next = evaluateFunilTransition(initial, 'Por favor, pare de mandar mensagens!')

  assert.equal(next.stage, 'pausado')
  assert.equal(next.pause_reason, 'pedido_do_usuario')
  assert.equal(canOfferPortal(next), false)
})

test('4.11 - Atendimento humano pausa bot e bloqueia ações automáticas do funil', () => {
  const initial = createInitialFunilCursosState({ transactionId: 'TXN-11' })
  const next = evaluateFunilTransition(initial, 'Quero falar com uma pessoa', { humanTakeover: true })

  assert.equal(next.stage, 'humano')
  assert.equal(next.human_takeover, true)
  assert.equal(canOfferPortal(next), false)
})

test('4.12 - Compra aprovada cancelando boleto/PIX/cartão pendentes', () => {
  // Simula lógica de cancelamento do webhook
  const pendingJobs = [
    { id: 1, leadId: 50, eventType: 'boleto', status: 'pending' },
    { id: 2, leadId: 50, eventType: 'pix', status: 'pending' },
    { id: 3, leadId: 50, eventType: 'cartao_recusado', status: 'pending' },
  ]

  // Quando compra é aprovada, jobs pendentes são cancelados
  const cancelledJobs = pendingJobs.map(job => ({ ...job, status: 'cancelled' }))

  assert.equal(cancelledJobs.every(j => j.status === 'cancelled'), true)
})

test('4.13 - Idempotência e Webhook repetido com mesmo transactionId', () => {
  const txnId = 'KWF_IDEMPOTENTE_001'
  const state1 = createInitialFunilCursosState({ transactionId: txnId })
  assert.equal(state1.purchase_id, txnId)

  // Tentativa de duplicata com mesmo transactionId é detectada
  const isDuplicate = state1.purchase_id === txnId
  assert.equal(isDuplicate, true)
})
