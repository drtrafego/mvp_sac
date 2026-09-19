/**
 * DO OUTRO LADO É UMA MÁQUINA? (detector estrutural, anti-loop)
 *
 * Port fiel de `/opt/gastaomatos/luana/whatsapp_bridge/detector_bot.py`
 * (SÓ LEITURA, é da Luana, é lá que a lógica original vive e evolui). Aqui
 * ela roda ANTES de chamar a ponte (`gerarResposta`, em ai-bridge.ts): se
 * quem está do outro lado é outro bot/auto-responder, o SAC não gasta uma
 * chamada do rate limit tentando conversar com uma máquina, e evita o loop
 * infinito de dois bots trocando mensagem (incidente real já visto na
 * operação, com custo real por mensagem na API oficial da Meta).
 *
 * A lógica de pontuação, os limiares e os comentários de cada sinal foram
 * copiados do arquivo original (ele documenta o motivo de cada corte, ex.:
 * LIMIAR=4 porque na varredura de 02/09/2026 era o ponto de corte em que as
 * conversas marcadas continuavam sendo só robô). Não invente sinal novo
 * aqui: se a Luana mudar a régua lá, replique a mudança aqui, não o
 * contrário.
 *
 * Diferenças conscientes do port (documentadas, não são bug):
 *  1. `parece_automatica`: no Python é a função de UMA mensagem, injetada do
 *     receiver.py (frases automáticas conhecidas do WhatsApp Business). O
 *     SAC não tem esse classificador; o parâmetro fica opcional (`opts.
 *     pareceAutomatica`) e o sinal 6 (densidade de automáticas) simplesmente
 *     não pontua enquanto ninguém plugar essa função aqui, exatamente como
 *     o Python quando chamado sem o argumento.
 *  2. `houve_botao` (clique em botão do WhatsApp): o Python também aceita
 *     `origem === "botao"`, um metadado que o webhook da Luana grava e que
 *     este SAC não tem (não existe `origem`/quick-reply tracking no schema
 *     de whatsapp_messages). Aqui o sinal sobrevive só pela via de texto
 *     (a mensagem normalizada bater com "tenho interesse" ou "quero saber
 *     mais"), que é a mesma matéria-prima disponível nos dois lados.
 *  3. `SequenceMatcher.ratio()` do Python (difflib, algoritmo de
 *     Ratcliff/Obershelp) não existe nativo em JS. Reimplementado abaixo
 *     (`sequenceRatio`) fiel ao algoritmo, sem a heurística de "autojunk"
 *     do Python (que só entra em cena com strings >= 200 chars e elementos
 *     populares — irrelevante pra texto de mensagem de WhatsApp).
 */

export type PapelTurno = 'lead' | 'bot'

export type TurnoComTempo = {
  role: PapelTurno
  text: string
  /** Quando a mensagem foi criada. Usado só pelo sinal 3 (relâmpago). */
  createdAt?: Date | string | null
}

export type ResultadoDeteccao = {
  bot: boolean
  pontos: number
  sinais: string[]
  msgsLead: number
}

const LIMIAR = 4
const MIN_MSGS_LEAD = 3

// quanto tempo entre a nossa mensagem e a resposta dela ainda é "relâmpago"
const SEGUNDOS_RELAMPAGO = 12

// saudação/apresentação: o que só se escreve no INÍCIO de uma conversa
const APRESENTACAO_RE = new RegExp(
  'com quem (eu )?(tenho o prazer de|falo|estou falando)|' +
    'qual (é |e )?(o )?seu (primeiro )?nome|me informe seu nome|informe seu nome|' +
    'pode me (dizer|informar) seu nome|' +
    '(seja )?bem.?vind[oa]s?\\b|' +
    'ol[áa][!,. ]+(bem|seja|como|em que|no que)|' +
    'estamos (felizes|muito felizes) (com|pela)|' +
    'obrigad[oa] por (entrar em )?contat|agradec\\w* (o |seu )?contat|' +
    'como (posso|podemos) (te )?ajudar|em que (posso|podemos) (te )?ajudar',
  'i',
)

// fórmula de atendimento: educada, genérica, não responde nada
const FORMULA_RE = new RegExp(
  'estou (à|a) disposi|estamos (à|a) disposi|qualquer d[úu]vida|' +
    'agradec\\w*|retornaremos|em breve|aguarde|encaminhar|' +
    'nosso hor[áa]rio de (atendimento|funcionamento)|' +
    'exclusiv[oa] para|apenas para|somente para|' +
    'n[ãa]o (posso|podemos) (te )?(ajudar|informar) (com )?isso|' +
    'como (posso|podemos) (te )?ajudar|em que (posso|podemos) (te )?ajudar|' +
    'obrigad[oa] pel[oa]|fico (à|a) disposi',
  'i',
)

// sinais de GENTE: qualquer um zera a conta
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/
const GENTE_RE = new RegExp(
  '\\bquanto custa|\\bqual (o |é o )?(valor|pre[çc]o|investimento)|' +
    '\\bpode ser (as|às)?\\s*\\d|\\bprefiro (as|às)?\\s*\\d|' +
    '\\bfecha(do|mos)?\\b.*\\d{1,2}\\s*h|\\bpode marcar|\\bquero (marcar|contratar|come[çc]ar)|' +
    '\\bn[ãa]o tenho interesse|\\bagora n[ãa]o|\\bmais pra frente|' +
    '\\bmeu nome (é|e) |\\bsou (o|a) (dono|dona|s[óo]ci)',
  'i',
)

function normalizar(texto?: string | null): string {
  let t = (texto || '').toLowerCase().normalize('NFKD')
  t = t.replace(/[̀-ͯ]/g, '') // remove marca combinante (acento), equivalente a unicodedata.combining()
  t = t.replace(/[^a-z0-9 ]+/g, ' ')
  return t.split(/\s+/).filter(Boolean).join(' ')
}

// --- reimplementação do difflib.SequenceMatcher.ratio() (Ratcliff/Obershelp) ---

function mapaPosicoesPorChar(b: string): Map<string, number[]> {
  const mapa = new Map<string, number[]>()
  for (let i = 0; i < b.length; i++) {
    const c = b[i]
    const arr = mapa.get(c)
    if (arr) arr.push(i)
    else mapa.set(c, [i])
  }
  return mapa
}

function maiorBlocoComum(
  a: string,
  b: string,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
  b2j: Map<string, number[]>,
): [number, number, number] {
  let besti = alo
  let bestj = blo
  let bestsize = 0
  let j2len = new Map<number, number>()
  for (let i = alo; i < ahi; i++) {
    const novoJ2len = new Map<number, number>()
    const indices = b2j.get(a[i])
    if (indices) {
      for (const j of indices) {
        if (j < blo) continue
        if (j >= bhi) break
        const k = (j2len.get(j - 1) || 0) + 1
        novoJ2len.set(j, k)
        if (k > bestsize) {
          besti = i - k + 1
          bestj = j - k + 1
          bestsize = k
        }
      }
    }
    j2len = novoJ2len
  }
  return [besti, bestj, bestsize]
}

function blocosCorrespondentes(a: string, b: string): Array<[number, number, number]> {
  const b2j = mapaPosicoesPorChar(b)
  const fila: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]]
  const blocos: Array<[number, number, number]> = []
  while (fila.length) {
    const [alo, ahi, blo, bhi] = fila.pop()!
    const [i, j, k] = maiorBlocoComum(a, b, alo, ahi, blo, bhi, b2j)
    if (k > 0) {
      blocos.push([i, j, k])
      if (alo < i && blo < j) fila.push([alo, i, blo, j])
      if (i + k < ahi && j + k < bhi) fila.push([i + k, ahi, j + k, bhi])
    }
  }
  return blocos
}

function sequenceRatio(a: string, b: string): number {
  if (!a || !b) return 0
  const total = a.length + b.length
  if (total === 0) return 1
  const blocos = blocosCorrespondentes(a, b)
  const casados = blocos.reduce((soma, [, , size]) => soma + size, 0)
  return (2.0 * casados) / total
}

function parecidas(a?: string | null, b?: string | null): number {
  const na = normalizar(a)
  const nb = normalizar(b)
  if (!na || !nb) return 0
  return sequenceRatio(na, nb)
}

/**
 * A pessoa contou algo do negócio dela, com palavra dela?
 * É o oposto de fórmula: texto médio/longo que NÃO casa com saudação nem com
 * fórmula de atendimento. É o que separa "gente lacônica" de "robô educado".
 */
function temConteudoProprio(texto?: string | null): boolean {
  const t = (texto || '').trim()
  if (t.length < 25) return false
  if (APRESENTACAO_RE.test(t) || FORMULA_RE.test(t)) return false
  return true
}

function paraEpochSegundos(d: Date | string | null | undefined): number | null {
  if (!d) return null
  const data = d instanceof Date ? d : new Date(d)
  const t = data.getTime()
  return Number.isNaN(t) ? null : t / 1000
}

function segundosEntre(inicio: Date | string | null | undefined, fim: Date | string | null | undefined): number {
  const a = paraEpochSegundos(inicio)
  const b = paraEpochSegundos(fim)
  if (a === null || b === null) return 999 // mesmo fallback do `except Exception: dt = 999` do Python
  return b - a
}

/**
 * historico: turnos da conversa em ordem cronológica (mais antigo primeiro),
 * incluindo a mensagem atual do lead na última posição.
 *
 * `pareceAutomatica`, se informado, é o equivalente da função de UMA
 * mensagem injetada no Python (ver diferença nº 1 no topo do arquivo).
 */
export function detectarBotDoOutroLado(
  historico: TurnoComTempo[],
  opts?: { pareceAutomatica?: (texto: string) => boolean },
): ResultadoDeteccao {
  const h = (historico || []).filter((m) => (m.text || '').trim())
  const leads = h.filter((m) => m.role === 'lead')

  if (leads.length < MIN_MSGS_LEAD) {
    return { bot: false, pontos: 0, sinais: ['poucas_mensagens'], msgsLead: leads.length }
  }

  // ---- porta de saída: sinal de gente zera tudo -------------------------
  for (const m of leads) {
    const t = m.text || ''
    if (EMAIL_RE.test(t) || GENTE_RE.test(t)) {
      return { bot: false, pontos: 0, sinais: ['sinal_de_gente'], msgsLead: leads.length }
    }
  }

  // ---- clique em botão: teve gente ali, então o corte sobe ---------------
  // (só a via de texto está disponível neste SAC; ver diferença nº 2 no topo)
  const houveBotao = leads.some((m) => {
    const norm = normalizar(m.text)
    return norm === 'tenho interesse' || norm === 'quero saber mais'
  })
  const limiar = LIMIAR + (houveBotao ? 2 : 0)

  const sinais: string[] = []
  let pontos = 0
  let forte = false

  // ---- 1. mesma mensagem literal repetida -------------------------------
  const vistos = new Map<string, TurnoComTempo[]>()
  for (const m of leads) {
    const k = normalizar(m.text)
    if (k.length < 25) continue // "oi", "ok", "?" repetem sem ser robô
    const ocorrencias = vistos.get(k) || []
    ocorrencias.push(m)
    vistos.set(k, ocorrencias)
  }
  for (const ocorrencias of vistos.values()) {
    if (ocorrencias.length >= 2) {
      pontos += 3
      forte = true
      sinais.push(`repetiu_literal_x${ocorrencias.length}`)
      break
    }
  }

  // ---- 2. apresentação DEPOIS de já ter conversado -----------------------
  let trocas = 0
  for (const m of h) {
    if (m.role === 'lead') {
      const t = m.text || ''
      if (trocas >= 3 && APRESENTACAO_RE.test(t)) {
        pontos += 3
        forte = true
        sinais.push(`apresentacao_depois_de_${trocas}_trocas`)
        break
      }
    }
    trocas += 1
  }

  // ---- 3. relâmpago + fórmula -------------------------------------------
  let relampagos = 0
  let anteriorBot: TurnoComTempo | null = null
  for (const m of h) {
    if (m.role === 'bot') {
      anteriorBot = m
      continue
    }
    if (!anteriorBot) continue
    const dt = segundosEntre(anteriorBot.createdAt, m.createdAt)
    if (dt >= 0 && dt <= SEGUNDOS_RELAMPAGO && FORMULA_RE.test(m.text || '')) {
      relampagos += 1
    }
  }
  if (relampagos >= 2) {
    pontos += 2
    sinais.push(`relampago_formulaico_x${relampagos}`)
  }

  // ---- 4. mesma resposta pra perguntas diferentes -------------------------
  const respostas: Array<[string, string]> = []
  let perguntaAnterior: string | null = null
  for (const m of h) {
    if (m.role === 'bot') {
      perguntaAnterior = m.text || ''
      continue
    }
    if (perguntaAnterior && perguntaAnterior.includes('?')) {
      respostas.push([perguntaAnterior, m.text || ''])
    }
  }
  buscaRespostaIgual: for (let i = 0; i < respostas.length; i++) {
    for (let j = i + 1; j < respostas.length; j++) {
      const pergDif = parecidas(respostas[i][0], respostas[j][0]) < 0.6
      const respIgual = parecidas(respostas[i][1], respostas[j][1]) > 0.8
      if (pergDif && respIgual && normalizar(respostas[i][1]).length >= 20) {
        pontos += 3
        sinais.push('mesma_resposta_perguntas_diferentes')
        break buscaRespostaIgual
      }
    }
  }

  // ---- 5. pergunta direta que nunca é respondida --------------------------
  let ignoradas = 0
  for (const [, resp] of respostas) {
    if (FORMULA_RE.test(resp) && !temConteudoProprio(resp)) ignoradas += 1
  }
  if (ignoradas >= 2) {
    pontos += 2
    sinais.push(`pergunta_direta_ignorada_x${ignoradas}`)
  }

  // ---- 6. densidade de automáticas ---------------------------------------
  if (opts?.pareceAutomatica) {
    const autos = leads.filter((m) => opts.pareceAutomatica!(m.text)).length
    if (autos >= 2 && autos >= leads.length / 2) {
      pontos += 2
      sinais.push(`automaticas_${autos}_de_${leads.length}`)
    }
  }

  // ---- desconto: ela contou algo do negócio dela --------------------------
  const proprias = leads.filter((m) => temConteudoProprio(m.text)).length
  if (proprias >= 2) {
    pontos -= 2
    sinais.push(`conteudo_proprio_x${proprias}`)
    forte = false
  }

  if (houveBotao) sinais.push('clique_de_botao')

  return {
    bot: pontos >= limiar || (forte && pontos >= 3 && !houveBotao),
    pontos,
    sinais,
    msgsLead: leads.length,
  }
}
