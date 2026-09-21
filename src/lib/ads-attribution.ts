/**
 * Atribuição de anúncio (Meta Marketing API) para um lead.
 *
 * Porta de agente_painel/app.py (utm_do_anuncio, campanhas_da_conta,
 * conta_do_agente): dado o ad_id do anúncio que trouxe o lead, consulta a
 * Graph API da conta de anúncios do CLIENTE e devolve campanha/conjunto/
 * anúncio e o url_tags (Parâmetros de URL da campanha) já com as macros
 * ({{campaign.name}} etc.) resolvidas, exatamente como a Meta resolve ao
 * montar o link do anúncio.
 *
 * Host correto: graph.facebook.com (Marketing API, dados de ANÚNCIO), nunca
 * graph.instagram.com — confirmado lendo graph_get() no painel antigo.
 */

const GRAPH_VERSION = (process.env.META_GRAPH_VERSION || 'v21.0').trim()
const GRAPH_HOST = 'https://graph.facebook.com'
const REQUEST_TIMEOUT_MS = 15000

export interface AdAttributionOk {
  ok: true
  adId: string
  adName: string | null
  adsetId: string | null
  adsetName: string | null
  campaignId: string | null
  campaignName: string | null
  urlTags: string | null
  urlTagsResolved: string | null
  utm: Record<string, string>
  dinamico: boolean // sobrou {{macro}} sem resolver (placement/site_source_name só se sabe no clique)
}

export interface AdAttributionErr {
  ok: false
  error: string
}

export type AdAttributionResult = AdAttributionOk | AdAttributionErr

// Cache de 1h em memória por processo: url_tags quase nunca muda e o mesmo
// anúncio traz dezenas de leads. Mesmo TTL do painel antigo (ADS_TTL).
// ATENÇÃO: é cache POR INSTÂNCIA de processo, sem garantia nenhuma entre
// invocações serverless (o projeto roda na Vercel: cada invocação pode cair
// numa instância fria, e a instância pode ser reciclada a qualquer momento).
// Serve só de alívio de latência/rate limit, nunca como fonte de verdade.
const CACHE_TTL_MS = 60 * 60 * 1000
const cache = new Map<string, { at: number; value: AdAttributionResult }>()

export function isNumericId(v: string | null | undefined): v is string {
  return !!v && /^\d+$/.test(v.trim())
}

export function normalizeAdAccountId(raw: string | null | undefined): string | null {
  const v = (raw || '').trim()
  if (!v) return null
  return v.startsWith('act_') ? v : `act_${v}`
}

/** url_tags (ou qualquer querystring) -> dicionário. Devolve tudo, não só utm_*. */
export function parseUtmQuery(qs: string | null | undefined): Record<string, string> {
  const clean = (qs || '').replace(/^[?&]+/, '')
  if (!clean) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of new URLSearchParams(clean)) {
    if (v) out[k] = v
  }
  return out
}

/**
 * UTM do link que a pessoa REALMENTE clicou (source_url de um referral de
 * Click-to-WhatsApp, por exemplo): vale mais que o url_tags do anúncio
 * porque é o estado no momento do clique, não o de hoje. Só os utm_*: o
 * resto da querystring (fbclid etc.) é ruído.
 */
export function utmFromClickUrl(url: string | null | undefined): Record<string, string> {
  const raw = (url || '').trim()
  if (!raw) return {}
  let query = ''
  try {
    query = new URL(raw).search
  } catch {
    return {}
  }
  const achados = parseUtmQuery(query)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(achados)) {
    if (k.toLowerCase().startsWith('utm_')) out[k] = v
  }
  return out
}

type AdGraphNode = {
  id?: string
  name?: string
  url_tags?: string
  account_id?: string
  campaign?: { id?: string; name?: string } | null
  adset?: { id?: string; name?: string } | null
}

// Macros que dependem da impressão (placement, site_source_name) não têm
// como ser resolvidas fora do clique: ficam como estão, "dinamico" sinaliza.
function resolveMacros(texto: string, ad: AdGraphNode): string {
  if (!texto) return ''
  const troca: Record<string, string> = {
    '{{ad.id}}': ad.id || '',
    '{{ad.name}}': ad.name || '',
    '{{adset.id}}': ad.adset?.id || '',
    '{{adset.name}}': ad.adset?.name || '',
    '{{campaign.id}}': ad.campaign?.id || '',
    '{{campaign.name}}': ad.campaign?.name || '',
  }
  let out = texto
  for (const [macro, valor] of Object.entries(troca)) {
    if (valor) out = out.split(macro).join(valor)
  }
  return out
}

/**
 * Busca no Graph API o url_tags do anúncio, com as macros resolvidas e já
 * quebrado em utm_*. Requer um token com escopo ads_read na conta de
 * anúncios dona do anúncio (settings.metaAdsAccessToken da empresa).
 *
 * `expectedAdAccountId` (settings.metaAdsAccountId da empresa) é OBRIGATÓRIO
 * e é conferido contra o account_id que a Graph API devolve para o ad_id.
 * O ad_id chega de fonte não confiável (parâmetro de URL de checkout: ver
 * src/app/api/webhooks/zouti/[slug]/route.ts e greenn/[slug]/route.ts), e um
 * token de sistema pode enxergar mais de uma conta de anúncios no mesmo
 * Business Manager. Sem essa checagem, um ad_id forjado (ou de outro cliente
 * do mesmo BM) vazaria nome de campanha/anúncio de conta alheia. Por isso a
 * ausência de metaAdsAccountId configurado também é tratada como erro, nunca
 * como "não filtra": aqui o padrão seguro é rejeitar, não abrir.
 */
export async function fetchAdAttribution(
  accessToken: string | null | undefined,
  adIdRaw: string | null | undefined,
  expectedAdAccountId: string | null | undefined
): Promise<AdAttributionResult> {
  const adId = (adIdRaw || '').trim()
  if (!adId || !isNumericId(adId)) return { ok: false, error: 'ad_id inválido ou ausente' }
  const token = (accessToken || '').trim()
  if (!token) return { ok: false, error: 'empresa sem metaAdsAccessToken configurado' }
  const contaEsperada = normalizeAdAccountId(expectedAdAccountId)
  if (!contaEsperada) return { ok: false, error: 'empresa sem metaAdsAccountId configurado (obrigatório para validar a origem do ad_id)' }

  const cacheKey = `${token.slice(-12)}:${contaEsperada}:${adId}`
  const hit = cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

  const url = new URL(`${GRAPH_HOST}/${GRAPH_VERSION}/${adId}`)
  url.searchParams.set('fields', 'id,name,url_tags,account_id,campaign{id,name},adset{id,name}')

  let result: AdAttributionResult
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const data: AdGraphNode & { error?: { message?: string } } = await res.json().catch(() => ({}))
    if (!res.ok) {
      result = { ok: false, error: (data?.error?.message || `graph ${res.status}`).slice(0, 160) }
    } else {
      const contaDoAnuncio = normalizeAdAccountId(data.account_id)
      if (contaDoAnuncio !== contaEsperada) {
        result = {
          ok: false,
          error: `ad_id não pertence à conta de anúncios configurada (esperado ${contaEsperada}, recebido ${contaDoAnuncio || 'desconhecido'})`,
        }
      } else {
        const cru = typeof data.url_tags === 'string' ? data.url_tags : ''
        const resolvido = resolveMacros(cru, data)
        result = {
          ok: true,
          adId: String(data.id ?? adId),
          adName: data.name ?? null,
          adsetId: data.adset?.id ?? null,
          adsetName: data.adset?.name ?? null,
          campaignId: data.campaign?.id ?? null,
          campaignName: data.campaign?.name ?? null,
          urlTags: cru || null,
          urlTagsResolved: resolvido || null,
          utm: parseUtmQuery(resolvido),
          dinamico: resolvido.includes('{{'),
        }
      }
    }
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message.slice(0, 160) : 'falha na chamada à Graph API' }
  }

  cache.set(cacheKey, { at: Date.now(), value: result })
  return result
}

/**
 * Nomes das campanhas de uma conta de anúncios. Porta de campanhas_da_conta():
 * útil para escopar leads quando duas empresas publicam pela MESMA página do
 * Facebook (a page_id sozinha não separa). Devolve null quando NÃO dá para
 * filtrar (sem conta/token, ou a Graph falhou) — o chamador deve tratar como
 * "não filtra nada", nunca como "lista vazia" (senão a tela esvazia por
 * problema técnico em vez de mostrar lead a mais).
 */
export async function listCampaignNamesForAdAccount(
  accessToken: string | null | undefined,
  adAccountIdRaw: string | null | undefined
): Promise<Set<string> | null> {
  const conta = normalizeAdAccountId(adAccountIdRaw)
  const token = (accessToken || '').trim()
  if (!conta || !token) return null

  const nomes = new Set<string>()
  let after: string | undefined
  let paginas = 0
  try {
    while (paginas < 10) {
      const url = new URL(`${GRAPH_HOST}/${GRAPH_VERSION}/${conta}/campaigns`)
      url.searchParams.set('fields', 'name')
      url.searchParams.set('limit', '200')
      if (after) url.searchParams.set('after', after)

      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const data: { data?: Array<{ name?: string }>; paging?: { cursors?: { after?: string } } } = await res.json().catch(() => ({}))
      if (!res.ok) return null

      for (const c of data.data || []) {
        if (c?.name) nomes.add(c.name)
      }
      after = data.paging?.cursors?.after
      paginas += 1
      if (!after || !(data.data || []).length) break
    }
  } catch {
    return null
  }
  return nomes
}
