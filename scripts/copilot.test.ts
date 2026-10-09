import test from 'node:test'
import assert from 'node:assert/strict'

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

  if (productName) {
    replacedText = replacedText
      .replace(/\{produto\}/gi, productName)
      .replace(/\{product\}/gi, productName)
  }

  const missingVars = replacedText.match(/\{([a-zA-Z0-9_]+)\}/g) || []

  return {
    draft: replacedText,
    source: bestMatch.title,
    missingVars,
  }
}

function buildContextualDraft(clientText: string, leadName: string, productName: string) {
  const missingInfo: string[] = []
  const productPlaceholder = productName || '{produto}'
  let contextualDraft = ''

  if (clientText.toLowerCase().includes('dificuldade') || clientText.toLowerCase().includes('ajuda') || clientText.toLowerCase().includes('acesso')) {
    contextualDraft = `Olá, ${leadName}! Vi que você mencionou uma dificuldade. Conte comigo para resolver isso agora! O que exatamente está acontecendo com seu acesso ao ${productPlaceholder}?`
  } else if (clientText.toLowerCase().includes('portal') || clientText.toLowerCase().includes('continuar')) {
    contextualDraft = `Olá, ${leadName}! Que maravilha ver seu interesse em continuar evoluindo no ${productPlaceholder}! Me conta, você gostaria de conhecer os detalhes da próxima etapa?`
  } else {
    contextualDraft = `Olá, ${leadName}! Tudo bem? Vi sua mensagem recente e estou aqui para te apoiar no ${productPlaceholder}. Como posso te ajudar hoje?`
  }

  const remainingVars = contextualDraft.match(/\{([a-zA-Z0-9_]+)\}/g) || []
  for (const v of remainingVars) {
    if (!missingInfo.includes(v)) {
      missingInfo.push(v)
    }
  }

  return {
    draft: contextualDraft,
    missingInfo,
  }
}

test('Copiloto: substituição de variáveis com resposta aprovada quando produto está preenchido', () => {
  const replies = [
    {
      id: 1,
      title: 'Dúvidas de Acesso ao Despertar',
      body: 'Oi, {nome}! Vi que você teve dúvidas para acessar o {produto}. Vamos resolver isso agora mesmo!',
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

test('Copiloto: resposta aprovada SEM produto NÃO inventa nome e sinaliza {produto}', () => {
  const replies = [
    {
      id: 1,
      title: 'Dúvidas de Acesso',
      body: 'Oi, {nome}! Vi que você teve dúvidas para acessar o {produto}. Vamos resolver isso agora mesmo!',
    },
  ]

  const tokens = tokenize('Não consigo entrar e acessar')
  // Produto vazio/ausente
  const result = matchAndFillReply(tokens, replies, 'Mariana', '')

  assert.ok(result)
  assert.equal(result.source, 'Dúvidas de Acesso')
  // Mantém {produto} no texto para o atendente preencher
  assert.equal(
    result.draft,
    'Oi, Mariana! Vi que você teve dúvidas para acessar o {produto}. Vamos resolver isso agora mesmo!'
  )
  assert.ok(!result.draft.includes('Despertar das Bellas'))
  assert.deepEqual(result.missingVars, ['{produto}'])
})

test('Copiloto: detecção de variáveis pendentes adicionais ({chave_pix}, {horario})', () => {
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

test('Copiloto: sugestão contextual COM produto real utiliza o produto correto', () => {
  const result = buildContextualDraft('Estou com dificuldade no acesso', 'Luciana', 'Mentoria Black')

  assert.equal(
    result.draft,
    'Olá, Luciana! Vi que você mencionou uma dificuldade. Conte comigo para resolver isso agora! O que exatamente está acontecendo com seu acesso ao Mentoria Black?'
  )
  assert.equal(result.missingInfo.length, 0)
})

test('Copiloto: sugestão contextual SEM produto NÃO inventa produto padrão e sinaliza {produto}', () => {
  const result = buildContextualDraft('Estou com dificuldade no acesso', 'Luciana', '')

  assert.equal(
    result.draft,
    'Olá, Luciana! Vi que você mencionou uma dificuldade. Conte comigo para resolver isso agora! O que exatamente está acontecendo com seu acesso ao {produto}?'
  )
  // Nunca deve inventar Despertar das Bellas
  assert.ok(!result.draft.includes('Despertar das Bellas'))
  assert.deepEqual(result.missingInfo, ['{produto}'])
})
