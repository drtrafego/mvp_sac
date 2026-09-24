import { or, sql, type SQL } from 'drizzle-orm'
import { recoveryLeads } from '@/lib/db/schema'

// mineracao_email/mineracao_whatsapp/mineracao_instagram e
// anuncio_meta_ads/anuncio_google_ads são FILTROS COMPOSTOS: dentro do
// universo já classificado pela categoria principal (precedência mantida),
// filtram pela segunda dimensão. Não são categorias novas no nível principal,
// então não mexem nas regras de precedência das rodadas anteriores.
export type InboxChannelFilter =
  | 'all'
  | 'whatsapp'
  | 'instagram'
  | 'email'
  | 'mineracao'
  | 'mineracao_email'
  | 'mineracao_whatsapp'
  | 'mineracao_instagram'
  | 'anuncio'
  | 'anuncio_meta_ads'
  | 'anuncio_google_ads'

type ChannelFields = {
  channel?: string | null
  platform?: string | null
  trackingSource?: string | null
  phone?: string | null
}

export type ChannelClassification = {
  isMineracao: boolean
  isAnuncio: boolean
  isEmail: boolean
  isInstagram: boolean
  isWhatsapp: boolean
}

// Canal REAL de contato de um lead já classificado como 'mineracao'. É uma
// segunda dimensão, independente da categoria principal: um lead pode ser
// categoria='mineracao' (porque tracking_source bateu em %prospeccao%) e
// mineracaoSubchannel='email' (porque o contato de verdade é por e-mail).
export type MineracaoSubchannel = 'email' | 'whatsapp' | 'instagram'
export type AnuncioSubcategory = 'meta_ads' | 'google_ads'

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
 * tempo (overlap), nenhum lead fica de fora das abas (buraco).
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
 *  2. anuncio DEPOIS de mineracao e ANTES de email/instagram. Depois de
 *     preservar a prioridade histórica de prospecção fria, tráfego pago
 *     precisa vencer colisões com canais orgânicos: "instagram_ads_agosto"
 *     contém "instagram", mas a origem de negócio é Anúncio; "fb_ads..." ou
 *     "meta_ads" não devem cair no else de WhatsApp só porque o contato real
 *     acontece por WhatsApp.
 *  3. email ANTES de instagram, pelo mesmo motivo de colisão de texto livre:
 *     "instagram_email_crosspost" bate nos dois (%instagram% e %email%).
 *     Email vence esse empate.
 *  4. instagram por último antes do else: depois de eliminar mineracao,
 *     anuncio e email, o que sobrar batendo em channel/platform/trackingSource
 *     ou no prefixo "ig_" do telefone é instagram.
 *  5. whatsapp é SEMPRE o else, nunca uma condição própria. channel=
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
    // Lista PRECISA ficar sincronizada com src/lib/origins.ts (normalizeOrigin,
    // bloco "1. Mineração"): são duas heurísticas de texto livre escritas à
    // mão em arquivos separados pro MESMO conceito de negócio, e já
    // divergiram uma vez de verdade em produção. Achado real (22/09/2026): o
    // CRM grava campaign_source canônico "Minerador" (ver
    // /opt/gastaomatos/conexoes_comuns/crm.md), e sync-agents.ts (bloco 5)
    // grava esse valor direto em trackingSource. "Minerador" bate em 'miner'
    // mas NÃO batia em 'mineracao'/'prospeccao': o lead aparecia certo em
    // Origens (que já tinha 'miner') e sumia da aba Mineração do Inbox (que
    // só tinha a lista estreita). Mudou um lado, mude o outro.
    trackingIncludes: ['mineracao', 'prospeccao', 'miner', 'mining', 'places'],
  },
  {
    name: 'anuncio',
    channelEquals: 'anuncio',
    platformEquals: 'anuncio',
    // Lista PRECISA ficar sincronizada com src/lib/origins.ts (normalizeOrigin,
    // bloco "2. Anúncio"). A ordem de CATEGORY_RULES mantém mineração acima
    // desta regra: "google_places_scraper" continua Mineração, enquanto
    // "meta_ads", "fb_ads" e "google_ads" passam a formar a aba Anúncio.
    trackingIncludes: [
      'meta_ads',
      'fb_ads',
      'facebook_ads',
      'google_ads',
      'gclid',
      'adwords',
      'gads',
      'meta',
      'facebook',
      'fb',
      'google',
      'anuncio',
      'ads',
      'instagram_ad',
    ],
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

/**
 * Sub-regras de origem paga, aplicadas SÓ dentro do universo que já bateu em
 * CATEGORY_RULES 'anuncio'. Google vem primeiro porque termos como
 * "google_ads" também contêm o termo genérico "ads"; se Google não vencer
 * esse empate, cairia em Meta pelo default legado. Meta Ads é o else dentro
 * de Anúncio porque a heurística antiga de origins.ts já tratava "ads" sem
 * "google" como Meta/Facebook/Instagram Ads, e porque hoje o dado real
 * confirmado chega como trackingSource='meta_ads' (CTWA e Conversions API).
 */
const ANUNCIO_SUBCATEGORY_RULES: CategoryRule[] = [
  {
    name: 'google_ads',
    trackingIncludes: ['google_ads', 'gclid', 'adwords', 'gads', 'google'],
  },
  {
    name: 'meta_ads',
    trackingIncludes: ['meta_ads', 'fb_ads', 'facebook_ads', 'meta', 'facebook', 'fb', 'anuncio', 'ads'],
  },
]

// Borda de palavra (regex ~*) no lugar do ILIKE '%needle%' puro. ILIKE por
// substring solta colide com texto livre de TERCEIROS que chega em
// trackingSource pelos 4 checkouts (Hotmart/Greenn/Zouti/Kiwify, onde o
// valor vem direto de utm_source/tracking.source, controlado pelo
// afiliado/vendedor, não é texto interno). Achado real do QA (22/09/2026):
// 'places' batia em "hotmart_marketplaces_afiliados" e 'miner' batia em
// "facebook_ads_examiner_leads", os dois com o termo colado dentro de uma
// palavra maior e SEM relação nenhuma com mineração.
//
// A borda é SÓ DO LADO ESQUERDO (`^` ou caractere não-letra antes do termo),
// de propósito NÃO simétrica. Testado e confirmado (script ad-hoc, Postgres
// e Node, 22/09/2026): borda dos DOIS lados quebra o valor canônico real do
// CRM ("Minerador", gravado por sync-agents.ts) porque ali 'miner' é PREFIXO
// de uma palavra maior ("Miner" + "ador"), não uma palavra isolada — com
// borda simétrica esse lead sumiria de novo da aba Mineração (o bug exato
// que a rodada 6 corrigiu). Borda só à esquerda resolve os dois falsos
// positivos confirmados (nos dois casos o termo aparece como SUFIXO,
// precedido de letra) sem reintroduzir aquele bug, e não muda nenhum dos
// 137 casos do teste de reconciliação nem os 3 negativos novos do QA.
//
// Limitação conhecida e NÃO resolvida por borda de palavra (reportado, não
// escondido): "bitcoin_mining_influencer_promo" tem 'mining' como palavra
// inteira, delimitada por '_' dos dois lados, estruturalmente IDÊNTICA ao
// caso legítimo "mining_campaign_leads". Nenhuma regra de borda de texto
// distingue os dois; resolver isso exigiria uma regra de negócio nova
// (lista de exclusão tipo "bitcoin"/"cripto", no molde do isDrLucas de
// origins.ts), fora do escopo desta correção e pendente de decisão.
function wordBoundaryPattern(needle: string): string {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `(^|[^a-z])${escaped}`
}

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
    // ~* = regex POSIX case-insensitive (Postgres já case-fold a classe
    // [^a-z] sob ~*, confirmado com teste direto contra o banco).
    parts.push(sql`${trackingSource} ~* ${wordBoundaryPattern(needle)}`)
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

// Mesmo CASE WHEN do nível principal, mas com as sub-regras de Anúncio e
// caindo em 'meta_ads' no else (default legado para "ads" genérico).
function anuncioSubcategoryLabelSql(): SQL {
  let expr: SQL = sql`'meta_ads'`
  for (let i = ANUNCIO_SUBCATEGORY_RULES.length - 1; i >= 0; i--) {
    const rule = ANUNCIO_SUBCATEGORY_RULES[i]
    expr = sql`case when ${ruleConditionSql(rule)} then ${rule.name} else (${expr}) end`
  }
  return expr
}

const MINERACAO_COMPOUND_PREFIX = 'mineracao_'
const ANUNCIO_COMPOUND_PREFIX = 'anuncio_'

/**
 * WHERE do banco pra uma aba de canal. Retorna undefined pra 'all' (ou
 * qualquer valor desconhecido): sem filtro nenhum.
 *
 * Também aceita filtros compostos:
 * - 'mineracao_email' / 'mineracao_whatsapp' / 'mineracao_instagram':
 *   categoria principal 'mineracao' E, dentro dela, o canal real de contato.
 * - 'anuncio_meta_ads' / 'anuncio_google_ads': categoria principal 'anuncio'
 *   E, dentro dela, a plataforma paga reconhecida.
 */
export function channelWhereCondition(chFilter: string | null | undefined): SQL | undefined {
  if (chFilter && chFilter.startsWith(MINERACAO_COMPOUND_PREFIX)) {
    const sub = chFilter.slice(MINERACAO_COMPOUND_PREFIX.length)
    if (sub === 'email' || sub === 'whatsapp' || sub === 'instagram') {
      return sql<boolean>`(${channelLabelSql()} = 'mineracao') and (${mineracaoSubchannelLabelSql()} = ${sub})`
    }
    return undefined
  }

  if (chFilter && chFilter.startsWith(ANUNCIO_COMPOUND_PREFIX)) {
    const sub = chFilter.slice(ANUNCIO_COMPOUND_PREFIX.length)
    if (sub === 'meta_ads' || sub === 'google_ads') {
      return sql<boolean>`(${channelLabelSql()} = 'anuncio') and (${anuncioSubcategoryLabelSql()} = ${sub})`
    }
    return undefined
  }

  if (
    chFilter !== 'whatsapp' &&
    chFilter !== 'instagram' &&
    chFilter !== 'email' &&
    chFilter !== 'mineracao' &&
    chFilter !== 'anuncio'
  ) {
    return undefined
  }
  return sql<boolean>`${channelLabelSql()} = ${chFilter}`
}

// Espelho em memória de wordBoundaryPattern/ruleConditionSql: mesma borda só
// à esquerda, mesmo motivo (ver comentário lá). `src` já chega lowercased
// aqui embaixo, então não precisa de flag 'i'.
function matchesWordBoundary(src: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^a-z])${escaped}`).test(src)
}

function matchesRule(rule: CategoryRule, fields: ChannelFields): boolean {
  const ch = (fields.channel || '').toLowerCase()
  const pl = (fields.platform || '').toLowerCase()
  const src = (fields.trackingSource || '').toLowerCase()
  const phone = (fields.phone || '').toLowerCase()

  if (rule.channelEquals && ch === rule.channelEquals) return true
  if (rule.platformEquals && pl === rule.platformEquals) return true
  if (rule.trackingIncludes.some(needle => matchesWordBoundary(src, needle))) return true
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
        isAnuncio: rule.name === 'anuncio',
        isEmail: rule.name === 'email',
        isInstagram: rule.name === 'instagram',
        isWhatsapp: false,
      }
    }
  }
  return { isMineracao: false, isAnuncio: false, isEmail: false, isInstagram: false, isWhatsapp: true }
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

/**
 * Complementar a classifyChannelInMemory para leads que JÁ são 'anuncio'.
 * Google vence termos genéricos como "ads"; Meta Ads é o default dentro de
 * Anúncio para manter o comportamento legado de tráfego pago não-Google.
 */
export function classifyAnuncioSubcategory(fields: ChannelFields): AnuncioSubcategory {
  for (const rule of ANUNCIO_SUBCATEGORY_RULES) {
    if (matchesRule(rule, fields)) {
      return rule.name as AnuncioSubcategory
    }
  }
  return 'meta_ads'
}

// Busca por telefone na caixa de texto do Inbox (client ConversationList e
// server /api/inbox): ÚNICA fonte da verdade, mesmo espírito de
// classifyChannelInMemory/channelWhereCondition acima (mesma regra nos dois
// lados, sem heurística duplicada escrita à mão duas vezes).
//
// O telefone é gravado só em dígitos (ver normalizeDigits em
// sync-agents.ts), mas quem digita no campo de busca digita do jeito
// "natural": com espaço, parênteses, traço, ou "+55" na frente. Sem
// normalizar dos dois lados antes do `.includes()`, qualquer pontuação no
// texto digitado quebra a busca mesmo com o telefone certinho no banco.
//
// Achado real (22/09/2026, investigação Erenita/Cleide Santos, Dr. Lucas):
// o lead existia no banco com o telefone exato (557581784614), na 3ª posição
// de recência da empresa, mas não aparecia numa busca por telefone — a causa
// era a falta desta normalização (o bug de nome congelado no título da
// conversa, que também afetava essa investigação, é tratado à parte, em
// outra frente).
export function normalizePhoneDigits(value: string | null | undefined): string {
  return (value || '').replace(/\D/g, '')
}

// Só considera "achou por telefone" se o termo digitado tiver pelo menos 1
// dígito. Sem essa guarda, uma busca por nome sem nenhum dígito (ex.:
// "Cleide") normalizaria pra string vazia, e `''.includes('')` é sempre
// `true` — toda linha bateria em "telefone" por engano.
export function matchesPhoneSearch(phone: string | null | undefined, term: string): boolean {
  const termDigits = normalizePhoneDigits(term)
  if (!termDigits) return false
  return normalizePhoneDigits(phone).includes(termDigits)
}
