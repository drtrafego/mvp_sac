import { or, sql, type SQL } from 'drizzle-orm'
import { recoveryLeads } from '@/lib/db/schema'

export type InboxChannelFilter = 'all' | 'whatsapp' | 'instagram' | 'email' | 'mineracao'

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

type ChannelCategory = 'mineracao' | 'email' | 'instagram'

interface CategoryRule {
  name: ChannelCategory
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

/**
 * WHERE do banco pra uma aba de canal. Retorna undefined pra 'all' (ou
 * qualquer valor desconhecido): sem filtro nenhum.
 */
export function channelWhereCondition(chFilter: string | null | undefined): SQL | undefined {
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
