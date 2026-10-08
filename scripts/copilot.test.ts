import test from 'node:test'
import assert from 'node:assert/strict'

// Teste das funções puras de tokenização e regras de substituição do Copiloto
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
}

function matchAndFillReply(
  searchTokens: string[],
  approvedList: Array<{ id: number; title: string; body: string }>,
  leadName: string,
  productName: string
) {
  let bestMatch: typeof approvedList[0] | null = null
  let maxScore = 0

  for (const reply of approvedList) {
    const replyTokens = tokenize(`${reply.title} ${reply.body}`)
    let score = 0
    for (const token of searchTokens) {
      if (replyTokens.includes(token)) score++
    }
    if (score > maxScore) {
      maxScore = score
      bestMatch = reply
    }
  }

  if (!bestMatch || maxScore === 0) return null

  let replacedText = bestMatch.body
    .replace(/\{nome\}/gi, leadName)
    .replace(/\{name\}/gi, leadName)
    .replace(/\{produto\}/gi, productName)
    .replace(/\{product\}/gi, productName)

  const missingVars = replacedText.match(/\{([a-zA-Z0-9_]+)\}/g) || []

  return {
    draft: replacedText,
    source: bestMatch.title,
    missingVars,
  }
}

test('Copiloto: substituição de variáveis com resposta aprovada', () => {
  const replies = [
    {
      id: 1,
      title: 'Dúvidas de Acesso ao Despertar',
      body: 'Oi, {nome}! Vi que você teve dúvidas para acessar o {produto}. Vamos resolver isso agora mesmo!',
    },
    {
      id: 2,
      title: 'Chave Pix para Pagamento',
      body: 'Oi, {nome}! Aqui está a chave Pix para seu pedido do {produto}: {chave_pix}. Me avise assim que pagar!',
    },
  ]

  const tokens = tokenize('Não consigo entrar e acessar o curso')
  const result = matchAndFillReply(tokens, replies, 'Mariana', 'Despertar das Bellas')

  assert.ok(result)
  assert.equal(result.source, 'Dúvidas de Acesso ao Despertar')
  assert.equal(
    result.draft,
    'Oi, Mariana! Vi que você teve dúvidas para acessar o Despertar das Bellas. Vamos resolver isso agora mesmo!'
  )
  assert.equal(result.missingVars.length, 0)
})

test('Copiloto: detecção de variáveis pendentes não resolvidas', () => {
  const replies = [
    {
      id: 2,
      title: 'Chave Pix para Pagamento',
      body: 'Oi, {nome}! Aqui está a chave Pix para seu pedido do {produto}: {chave_pix}. Me avise até {horario}!',
    },
  ]

  const tokens = tokenize('Gostaria de pagar via pix')
  const result = matchAndFillReply(tokens, replies, 'Carlos', 'Portal')

  assert.ok(result)
  assert.equal(result.source, 'Chave Pix para Pagamento')
  assert.deepEqual(result.missingVars, ['{chave_pix}', '{horario}'])
})

test('Copiloto: fallback contextual quando nenhuma resposta aprovada tem pontuação', () => {
  const replies = [
    { id: 1, title: 'Boleto Vencido', body: 'Seu boleto venceu' }
  ]

  const tokens = tokenize('mensagem sem correspondencia com o catalogo xyz')
  const result = matchAndFillReply(tokens, replies, 'Carlos', 'Portal')

  assert.equal(result, null)
})
