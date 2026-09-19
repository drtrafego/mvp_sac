// Teste isolado (sem rede, sem banco) do port de detector_bot.py pra
// src/lib/ai/bot-detector.ts. Cada caso cita o trecho/regra de origem no
// arquivo Python (SÓ LEITURA, /opt/gastaomatos/luana/whatsapp_bridge/
// detector_bot.py) que ele exercita.
//
// Uso: npx tsx scripts/test-bot-detector.ts

import assert from 'node:assert/strict'
import { detectarBotDoOutroLado, type TurnoComTempo } from '../src/lib/ai/bot-detector'

let passou = 0
let falhou = 0

function caso(nome: string, fn: () => void) {
  try {
    fn()
    passou++
    console.log(`OK   ${nome}`)
  } catch (err) {
    falhou++
    console.error(`FAIL ${nome}`)
    console.error(err)
  }
}

function turno(role: 'lead' | 'bot', text: string, tSegundos?: number): TurnoComTempo {
  return { role, text, createdAt: tSegundos !== undefined ? new Date(tSegundos * 1000) : undefined }
}

// ---------------------------------------------------------------------------
// 1. `if len(leads) < MIN_MSGS_LEAD: return {"bot": False, ..., "sinais":
//    ["poucas_mensagens"]}` — "nada é julgado antes de 3 mensagens do lead"
// ---------------------------------------------------------------------------
caso('poucas_mensagens: menos de 3 msgs do lead nunca marca', () => {
  const r = detectarBotDoOutroLado([turno('lead', 'Oi'), turno('bot', 'Olá, tudo bem?'), turno('lead', 'Tudo sim')])
  assert.equal(r.bot, false)
  assert.deepEqual(r.sinais, ['poucas_mensagens'])
  assert.equal(r.msgsLead, 2)
})

// ---------------------------------------------------------------------------
// 2. `GENTE_RE` (`\bquanto custa|...`) zera a conta mesmo com um sinal FORTE
//    (repetição literal) presente — "qualquer sinal de gente... ZERA a conta"
// ---------------------------------------------------------------------------
caso('sinal_de_gente (GENTE_RE "quanto custa") sobrepõe até um sinal forte', () => {
  const repetida = 'Bom dia, gostaria de saber mais sobre o produto de vocês por favor'
  const r = detectarBotDoOutroLado([
    turno('lead', repetida),
    turno('bot', 'Claro, posso ajudar'),
    turno('lead', repetida), // repetição literal: sinal FORTE isolado
    turno('bot', 'Certo, um momento'),
    turno('lead', 'Quanto custa esse plano mensal?'), // GENTE_RE: "\bquanto custa"
  ])
  assert.equal(r.bot, false)
  assert.deepEqual(r.sinais, ['sinal_de_gente'])
  assert.equal(r.pontos, 0)
})

// ---------------------------------------------------------------------------
// 3. `EMAIL_RE` também zera a conta (mesma porta de saída do item 2)
// ---------------------------------------------------------------------------
caso('sinal_de_gente (EMAIL_RE) também zera', () => {
  const r = detectarBotDoOutroLado([
    turno('lead', 'Oi, boa tarde'),
    turno('bot', 'Boa tarde, em que posso ajudar?'),
    turno('lead', 'Queria tirar uma dúvida rápida'),
    turno('bot', 'Pode perguntar'),
    turno('lead', 'Pode me chamar nesse email: cliente@exemplo.com'),
  ])
  assert.equal(r.bot, false)
  assert.deepEqual(r.sinais, ['sinal_de_gente'])
})

// ---------------------------------------------------------------------------
// 4. Sinal FORTE nº 1: "a MESMA mensagem literal duas vezes" (>= 25 chars
//    normalizados). Isolado, sem GENTE_RE, marca via
//    `forte and pontos >= 3 and not houve_botao` mesmo abaixo do LIMIAR=4.
// ---------------------------------------------------------------------------
caso('repetiu_literal: mensagem longa repetida marca sozinha (sinal forte)', () => {
  const repetida = 'Estamos verificando sua solicitação, aguarde só um instante aqui'
  const r = detectarBotDoOutroLado([
    turno('lead', 'Oi, preciso de ajuda'),
    turno('bot', 'Pode falar'),
    turno('lead', repetida),
    turno('bot', 'Entendi'),
    turno('lead', repetida),
  ])
  assert.equal(r.bot, true)
  assert.ok(r.sinais.some((s) => s.startsWith('repetiu_literal_x')))
  assert.equal(r.pontos, 3)
  assert.equal(r.msgsLead, 3)
})

// ---------------------------------------------------------------------------
// 5. Sinal FORTE nº 2: "saudação de apresentação DEPOIS de já ter
//    conversado (reset de contexto)" — `trocas >= 3 and APRESENTACAO_RE`
// ---------------------------------------------------------------------------
caso('apresentacao_depois_de_trocas: reset de contexto marca sozinho (sinal forte)', () => {
  const r = detectarBotDoOutroLado([
    turno('lead', 'Oi, bom dia'),
    turno('bot', 'Bom dia, tudo bem.'),
    turno('lead', 'Preciso de ajuda'),
    turno('bot', 'Claro, um momento.'),
    turno('lead', 'Olá! Seja bem-vindo(a), como posso te ajudar?'), // APRESENTACAO_RE
  ])
  assert.equal(r.bot, true)
  assert.ok(r.sinais.some((s) => s.startsWith('apresentacao_depois_de_')))
  assert.equal(r.pontos, 3)
})

// ---------------------------------------------------------------------------
// 6. Sinais fracos somando: "3. resposta relâmpago combinada com texto
//    formulaico" (FORMULA_RE dentro de SEGUNDOS_RELAMPAGO=12s) + "5. pergunta
//    direta nossa que nunca é respondida, sempre com fórmula". Nenhum dos
//    dois é forte isolado, mas a SOMA cruza o LIMIAR=4.
// ---------------------------------------------------------------------------
caso('relampago_formulaico + pergunta_direta_ignorada somam até o LIMIAR', () => {
  const r = detectarBotDoOutroLado([
    turno('lead', 'Oi'),
    turno('bot', 'Você já tem experiência anterior na área?', 0),
    turno('lead', 'Estou à disposição para qualquer dúvida, obrigado', 5), // dt=5s <= 12s, bate FORMULA_RE
    turno('bot', 'Podemos agendar uma call essa semana?', 20),
    turno('lead', 'Estamos à disposição para qualquer dúvida, muito obrigado pelo contato', 25), // dt=5s
  ])
  assert.equal(r.bot, true)
  assert.ok(r.sinais.includes('relampago_formulaico_x2'), `sinais=${r.sinais}`)
  assert.ok(r.sinais.includes('pergunta_direta_ignorada_x2'), `sinais=${r.sinais}`)
  assert.ok(r.pontos >= 4, `pontos=${r.pontos}`)
})

// ---------------------------------------------------------------------------
// 7. Desconto: "ela contou algo do negócio dela" (`_tem_conteudo_proprio`,
//    >=2 ocorrências tiram 2 pontos e derrubam o `forte`) — é o que separa
//    lead humano lacônico/específico de robô educado. Conversa de gente de
//    verdade não pode marcar.
// ---------------------------------------------------------------------------
caso('conteudo_proprio: conversa humana normal nunca marca (desconto)', () => {
  const r = detectarBotDoOutroLado([
    turno('lead', 'Oi, tudo bem?'),
    turno('bot', 'Tudo ótimo, e você?'),
    turno('lead', 'Estou interessado no curso, pode me explicar melhor como funciona?'),
    turno('bot', 'Funciona em módulos gravados, com suporte semanal.'),
    turno('lead', 'Perfeito, então acho melhor eu fazer o pagamento à vista mesmo'),
  ])
  assert.equal(r.bot, false)
  assert.ok(r.sinais.some((s) => s.startsWith('conteudo_proprio_x')), `sinais=${r.sinais}`)
  assert.ok(r.pontos <= 0, `pontos=${r.pontos}`)
})

console.log(`\n${passou} passou, ${falhou} falhou`)
if (falhou > 0) process.exit(1)
