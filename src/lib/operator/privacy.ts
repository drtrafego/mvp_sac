import type { OperatorPlan } from './catalog'

export type RedactedRequest = { text: string; markers: Map<string, string> }

// O planejador só recebe o vocabulário de intenção. Isto é uma allowlist, e não
// uma tentativa de reconhecer nomes: tudo que não estiver aqui é dado privado.
const ALLOWED_WORDS = new Set([
  'a', 'ao', 'aos', 'as', 'com', 'como', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos', 'o', 'os', 'ou', 'para', 'por', 'sem', 'sobre', 'um', 'uma', 'uns', 'umas',
  'agendado', 'agendar', 'agendamento', 'anotar', 'busca', 'buscar', 'busque', 'chamada', 'chamadas', 'comentario', 'comentarios', 'contato', 'contatos', 'criar', 'crie', 'empresa', 'empresas',
  'etapa', 'etapas', 'funil', 'hoje', 'instagram', 'lead', 'leads', 'ligar', 'ligue', 'link', 'links', 'lista', 'listar', 'liste', 'mover', 'move', 'nota', 'notas', 'ontem', 'palavra', 'palavras',
  'passar', 'post', 'posts', 'reel', 'reels', 'regra', 'regras', 'todos', 'todas', 'ver', 'veja', 'qual', 'quais', 'que', 'quem', 'onde', 'quando', 'mostrar', 'mostre', 'pipeline', 'automacao', 'automacoes', 'sao', 'tem', 'ha', 'telefone',
])

function normalized(value: string) {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR')
}

function isAllowedToken(token: string) {
  const canonical = normalized(token)
  return ALLOWED_WORDS.has(canonical)
}

type MarkerKind = 'T' | 'LINK' | 'CONTATO' | 'PALAVRA'

/**
 * Converte qualquer conteúdo que não seja intenção do produto em marcador
 * estável. Não consulta leads: a proteção funciona também para pessoa nova,
 * inexistente, apelido ou empresa com milhões de registros.
 */
export function redactOperatorText(request: string): RedactedRequest {
  const markers = new Map<string, string>()
  const indexes: Record<MarkerKind, number> = { T: 0, LINK: 0, CONTATO: 0, PALAVRA: 0 }
  const stable = new Map<string, string>()
  const markerFor = (kind: MarkerKind, original: string) => {
    const key = `${kind}:${normalized(original)}`
    const prior = stable.get(key)
    if (prior) return prior
    indexes[kind] += 1
    const marker = kind === 'T' ? `[T${indexes[kind]}]` : `[${kind}_${indexes[kind]}]`
    stable.set(key, marker)
    markers.set(marker, original)
    return marker
  }

  // Primeiro protege blocos que podem conter pontuação ou mais de um token.
  let text = request
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"']+/giu, value => markerFor('LINK', value))
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, value => markerFor('CONTATO', value))
    .replace(/(?<![\d+])\+?(?:\d[\s().-]*){7,}\d(?!\d)/gu, value => markerFor('CONTATO', value))
    .replace(/(["'])((?:(?!\1).){1,200})\1/gu, (_whole, _quote, value: string) => markerFor('PALAVRA', value))

  // "palavra X" e "palavra-chave X" são intenções válidas, mas X é dado do
  // usuário. Pula conectivos para que "qual a palavra do post" não masque
  // indevidamente "post" como se fosse a senha.
  const skippedAfterKeyword = new Set(['a', 'o', 'as', 'os', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'nas', 'no', 'nos', 'para', 'por', 'com', 'que', 'qual', 'quais', 'um', 'uma'])
  text = text.replace(/\b(palavra(?:-chave)?)((?:\s+[\p{L}\p{N}_'-]+)+)/giu, (_whole, prefix: string, tail: string) => {
    const tokens = tail.trim().split(/\s+/u)
    // Preposições como "do" introduzem uma explicação da palavra, e não a
    // senha: "qual a palavra do post de hoje".
    if (new Set(['da', 'das', 'de', 'do', 'dos', 'em', 'na', 'nas', 'no', 'nos', 'para', 'por', 'com', 'sobre']).has(normalized(tokens[0] ?? ''))) return `${prefix}${tail}`
    const index = tokens.findIndex(token => !skippedAfterKeyword.has(normalized(token)))
    if (index < 0) return `${prefix}${tail}`
    tokens[index] = markerFor('PALAVRA', tokens[index])
    return `${prefix} ${tokens.join(' ')}`
  })

  // "E." pode ser a inicial de uma pessoa, não o conectivo permitido.
  text = text.replace(/(\p{Lu}[\p{L}'-]*\s+)([AEO])(?=\.?\s+\p{Lu}[\p{L}'-]*)/gu, (_whole, prefix: string, initial: string) => `${prefix}${markerFor('T', initial)}`)

  // Pontuação é estrutural; toda palavra fora da allowlist vira [Tn].
  text = text.replace(/[\p{L}\p{N}_'-]+/gu, token => markers.has(`[${token}]`) || isAllowedToken(token) ? token : markerFor('T', token))
  return { text: text.slice(0, 4000), markers }
}

export async function redactRequestForCompany(_companyId: number, request: string): Promise<RedactedRequest> {
  return redactOperatorText(request)
}

export function resolvePlanMarkers(plan: OperatorPlan, markers: Map<string, string>): OperatorPlan {
  const resolve = (value: string) => value.replace(/\[(?:T\d+|LINK_\d+|CONTATO_\d+|PALAVRA_\d+)\]/g, marker => markers.get(marker) ?? '')
  return {
    ...plan,
    actions: plan.actions.map(action => action.type === 'buscar_lead'
      ? { ...action, query: resolve(action.query).trim().slice(0, 200) || 'sem termo' }
      : action),
  } as OperatorPlan
}
