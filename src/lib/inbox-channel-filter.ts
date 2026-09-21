import { or, sql, type SQL } from 'drizzle-orm'
import { recoveryLeads } from '@/lib/db/schema'

// mineracao_email/mineracao_whatsapp/mineracao_instagram são o FILTRO
// COMPOSTO: dentro do universo já classificado como 'mineracao' (categoria
// principal, precedência mantida), filtra pela segunda dimensão (canal REAL
// de contato do lead). Não são categorias novas no nível principal, então
// não mexem em nenhuma regra de precedência das 4 rodadas anteriores.
export type InboxChannelFilter =
  | 'all'
  | 'whatsapp'
  | 'instagram'
  | 'email'
  | 'mineracao'
  | 'mineracao_email'
  | 'mineracao_whatsapp'
  | 'mineracao_instagram'

type ChannelFields = {
  channel?: string | null
  platform?: string | null
  trackingSource?: string | null
  phone?: string | null
}

export type ChannelClassification = {
  isMineracao: boolean
  isEmail: boolean
  isInstagram: boolean
  isWhatsapp: boolean
}

// Canal REAL de contato de um lead já classificado como 'mineracao'. É uma
// segunda dimensão, independente da categoria principal: um lead pode ser
// categoria='mineracao' (porque tracking_source bateu em %prospeccao%) e
// mineracaoSubchannel='email' (porque o contato de verdade é por e-mail).
export type MineracaoSubchannel = 'email' | 'whatsapp' | 'instagram'

interface CategoryRule {
  name: string
  channelEquals?: string
  platformEquals?: string
  trackingIncludes: string[]
  phonePrefix?: string
}

/**
 * ÚNICA fonte da verdade de "que canal é este lead". Tanto o WHERE do banco
 * (channelWhereCondition, usado em /api/inbox, /api/inbox/counts e
 * /api/v1/.../conversations) quanto o filtro em memória do ConversationList
 * (classifyChannelInMemory) leem esta MESMA lista de regras. Não existem mais
 * dois lugares com a heurística escrita à mão, então SQL e memória não têm
 * como divergir de novo (motivo direto das rodadas 2 e 3 de bug).
 *
 * A ORDEM DESTA LISTA *É* A REGRA DE NEGÓCIO (precedência, não OR
 * independente): a primeira regra que bater vence, e só entra na próxima se
 * a anterior não bateu. Tudo que não bater em nenhuma cai em 'whatsapp' (o
 * "else", nunca uma condição própria). Isso garante mutual exclusion e
 * cobertura total POR CONSTRUÇÃO: nenhum lead cai em duas abas ao mesmo
 * tempo (overlap), nenhum lead fica de fora das 4 abas (buraco).
 *
 * POR QUE ESTA ORDEM ESPECÍFICA (mudar a ordem muda o resultado; documentado
 * porque já foi esquecido antes, isto é a 4ª rodada corrigindo a mesma
 * heurística):
 *
 *  1. mineracao PRIMEIRO. O tracking_source de prospecção é texto livre e
 *     colide com os outros dois: "prospeccao_email_followup" bate em
 *     %prospeccao% (mineracao) E em %email% (email) ao mesmo tempo;
 *     "PROSPECCAO_INSTAGRAM_MINERACAO" bate em mineracao E em instagram.
 *     Testar mineracao primeiro garante que esses leads ficam em mineracao,
 *     nunca contados de novo em email/instagram.
 *  2. email ANTES de instagram, pelo mesmo motivo de colisão de texto livre:
 *     "instagram_email_crosspost" bate nos dois (%instagram% e %email%).
 *     Email vence esse empate.
 *  3. instagram por último antes do else: depois de eliminar mineracao e
 *     email, o que sobrar batendo em channel/platform/trackingSource ou no
 *     prefixo "ig_" do telefone é instagram.
 *  4. whatsapp é SEMPRE o else, nunca uma condição própria. channel=
 *     'whatsapp', NULL, '' ou qualquer valor não mapeado caem aqui. É o que
 *     resolve, por construção, o buraco de NULL/vazio das rodadas 1 e 2 (uma
 *     condição own de whatsapp com coluna NULL, em lógica de 3 valores,
 *     nunca dava TRUE nem FALSE, dava NULL, e o WHERE descartava a linha).
 *
 * Se a regra de negócio pedir outra prioridade um dia, mude só esta lista.
 */
const CATEGORY_RULES: CategoryRule[] = [
  {
    name: 'mineracao',
    channelEquals: 'mineracao',
    platformEquals: 'mineracao',
    trackingIncludes: ['mineracao', 'prospeccao'],
  },
  {
    name: 'email',
    channelEquals: 'email',
    trackingIncludes: ['email', 'brevo'],
  },
  {
    name: 'instagram',
    channelEquals: 'instagram',
    platformEquals: 'instagram',
    trackingIncludes: ['instagram'],
    phonePrefix: 'ig_',
  },
]

/**
 * Sub-regras de canal REAL de contato, aplicadas SÓ dentro do universo que já
 * bateu em CATEGORY_RULES 'mineracao' (a Aria/Gastão confirmou: mineracao
 * sempre vence no canal principal, isto aqui é uma segunda dimensão de
 * filtro, não uma categoria nova). Mesmo mecanismo de precedência do nível
 * principal, mesma justificativa de ordem:
 *
 *  1. email primeiro: tracking_source de mineração por e-mail costuma trazer
 *     "email"/"mail"/"brevo" no texto (ex.: "prospeccao_email_followup"), que
 *     colide com o texto livre de instagram nalguns casos combinados.
 *  2. instagram depois: channel/platform='instagram', tracking com
 *     "instagram"/"direct", ou telefone com prefixo "ig_".
 *  3. whatsapp é o else: é o canal de outreach mais comum da mineração
 *     (WhatsApp Outreach), e qualquer lead que não bater nos sinais de
 *     e-mail/instagram cai aqui, por construção, sem buraco.
 *
 * Espelha a mesma partição feita hoje em src/lib/origins.ts (normalizeOrigin,
 * bloco "1. Mineração"), que já mostra estas 3 subcategorias no dashboard de
 * Origens. Aqui é a mesma lógica de negócio, reaproveitada pro Inbox.
 */
const MINERACAO_SUBCATEGORY_RULES: CategoryRule[] = [
  {
    name: 'email',
    channelEquals: 'email',
    trackingIncludes: ['email', 'mail', 'brevo'],
  },
  {
    name: 'instagram',
    channelEquals: 'instagram',
    platformEquals: 'instagram',
    trackingIncludes: ['instagram', 'direct'],
    phonePrefix: 'ig_',
  },
]

// Condição SQL (booleana) de UMA regra: bate em qualquer um dos sinais dela.
// coalesce(..., false): channel/platform/trackingSource são colunas
// nullable, e em lógica de 3 valores do SQL "coluna = X" com coluna NULL não
// dá FALSE, dá NULL; "OR" de puro NULL também fica NULL, não FALSE. Sem o
// coalesce aqui, um WHERE com essa condição descarta a linha inteira em vez
// de tratá-la como "não bateu" (bug da rodada 1/2).
function ruleConditionSql(rule: CategoryRule): SQL {
  const channel = recoveryLeads.channel
  const platform = recoveryLeads.platform
  const trackingSource = recoveryLeads.trackingSource
  const phone = recoveryLeads.phone

  const parts: SQL[] = []
  if (rule.channelEquals) parts.push(sql`lower(${channel}) = ${rule.channelEquals}`)
  if (rule.platformEquals) parts.push(sql`lower(${platform}) = ${rule.platformEquals}`)
  for (const needle of rule.trackingIncludes) {
    parts.push(sql`${trackingSource} ilike ${'%' + needle + '%'}`)
  }
  if (rule.phonePrefix) {
    parts.push(sql`left(lower(${phone}), ${rule.phonePrefix.length}) = ${rule.phonePrefix}`)
  }

  return sql<boolean>`coalesce(${or(...parts)}, false)`
}

// Um único CASE WHEN, testando as regras na ordem de CATEGORY_RULES e caindo
// em 'whatsapp' no else. É a tradução direta da precedência em SQL: por isso
// nenhuma aba precisa mais de NOT/coalesce combinando as outras três (o jeito
// que causou o buraco de NULL na rodada 1/2) nem de OR independente por aba
// (o jeito que causou o overlap textual da rodada 3).
function channelLabelSql(): SQL {
  let expr: SQL = sql`'whatsapp'`
  for (let i = CATEGORY_RULES.length - 1; i >= 0; i--) {
    const rule = CATEGORY_RULES[i]
    expr = sql`case when ${ruleConditionSql(rule)} then ${rule.name} else (${expr}) end`
  }
  return expr
}

// Mesmo CASE WHEN do nível principal, mas com as sub-regras de mineração e
// caindo em 'whatsapp' no else (o "WhatsApp Outreach" da mineração). Só faz
// sentido avaliar isto sobre linhas que já bateram em 'mineracao' no nível
// principal; channelWhereCondition sempre combina os dois com AND.
function mineracaoSubchannelLabelSql(): SQL {
  let expr: SQL = sql`'whatsapp'`
  for (let i = MINERACAO_SUBCATEGORY_RULES.length - 1; i >= 0; i--) {
    const rule = MINERACAO_SUBCATEGORY_RULES[i]
    expr = sql`case when ${ruleConditionSql(rule)} then ${rule.name} else (${expr}) end`
  }
  return expr
}

const MINERACAO_COMPOUND_PREFIX = 'mineracao_'

/**
 * WHERE do banco pra uma aba de canal. Retorna undefined pra 'all' (ou
 * qualquer valor desconhecido): sem filtro nenhum.
 *
 * Também aceita os filtros compostos 'mineracao_email' / 'mineracao_whatsapp'
 * / 'mineracao_instagram': categoria principal 'mineracao' (a mesma condição
 * de sempre, precedência intacta) E, dentro dela, o canal real de contato.
 */
export function channelWhereCondition(chFilter: string | null | undefined): SQL | undefined {
  if (chFilter && chFilter.startsWith(MINERACAO_COMPOUND_PREFIX)) {
    const sub = chFilter.slice(MINERACAO_COMPOUND_PREFIX.length)
    if (sub === 'email' || sub === 'whatsapp' || sub === 'instagram') {
      return sql<boolean>`(${channelLabelSql()} = 'mineracao') and (${mineracaoSubchannelLabelSql()} = ${sub})`
    }
    return undefined
  }

  if (chFilter !== 'whatsapp' && chFilter !== 'instagram' && chFilter !== 'email' && chFilter !== 'mineracao') {
    return undefined
  }
  return sql<boolean>`${channelLabelSql()} = ${chFilter}`
}

function matchesRule(rule: CategoryRule, fields: ChannelFields): boolean {
  const ch = (fields.channel || '').toLowerCase()
  const pl = (fields.platform || '').toLowerCase()
  const src = (fields.trackingSource || '').toLowerCase()
  const phone = (fields.phone || '').toLowerCase()

  if (rule.channelEquals && ch === rule.channelEquals) return true
  if (rule.platformEquals && pl === rule.platformEquals) return true
  if (rule.trackingIncludes.some(needle => src.includes(needle))) return true
  if (rule.phonePrefix && phone.startsWith(rule.phonePrefix)) return true
  return false
}

/**
 * Espelho em memória de channelWhereCondition, usado pelo ConversationList
 * (contagem inicial e filtro da lista já carregada). Mesma lista de regras,
 * mesma ordem, então mesmo resultado do SQL, célula por célula, sempre.
 */
export function classifyChannelInMemory(fields: ChannelFields): ChannelClassification {
  for (const rule of CATEGORY_RULES) {
    if (matchesRule(rule, fields)) {
      return {
        isMineracao: rule.name === 'mineracao',
        isEmail: rule.name === 'email',
        isInstagram: rule.name === 'instagram',
        isWhatsapp: false,
      }
    }
  }
  return { isMineracao: false, isEmail: false, isInstagram: false, isWhatsapp: true }
}

/**
 * Complementar a classifyChannelInMemory: dado um lead que JÁ é 'mineracao'
 * (chamar classifyChannelInMemory antes e checar isMineracao), diz qual é o
 * canal real de contato dele. Mesma lista de regras usada no
 * mineracaoSubchannelLabelSql, então SQL e memória não têm como divergir.
 *
 * Chamar isto num lead que não é mineracao não tem efeito colateral (é uma
 * pergunta válida, só que fora de contexto de negócio): a função classifica
 * o canal real igual faria dentro do universo mineracao, não valida a
 * categoria principal, quem chama é responsável por checar isMineracao antes.
 */
export function classifyMineracaoSubchannel(fields: ChannelFields): MineracaoSubchannel {
  for (const rule of MINERACAO_SUBCATEGORY_RULES) {
    if (matchesRule(rule, fields)) {
      return rule.name as MineracaoSubchannel
    }
  }
  return 'whatsapp'
}
