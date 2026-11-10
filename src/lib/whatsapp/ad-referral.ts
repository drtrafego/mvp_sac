// Lead que clica num anúncio Click-to-WhatsApp chega com `referral` dentro da
// mensagem do webhook da Meta (source_type, source_id = id do anúncio,
// headline, source_url, ctwa_clid). O SAC ignorava esse campo: o lead entrava
// como "whatsapp_direto" e nunca aparecia na aba Anúncio.
export type WhatsAppAdReferral = {
  metaAdId: string | null
  adName: string | null
  sourceUrl: string | null
  ctwaClid: string | null
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text ? text.slice(0, max) : null
}

export function extractAdReferral(message: unknown): WhatsAppAdReferral | null {
  if (!message || typeof message !== 'object') return null
  const raw = (message as { referral?: unknown }).referral
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const referral = raw as Record<string, unknown>
  const sourceType = clean(referral.source_type, 20)?.toLowerCase() ?? null
  const ctwaClid = clean(referral.ctwa_clid, 300)
  // ctwa_clid só existe em clique de anúncio Click-to-WhatsApp, inclusive quando
  // source_type é "post" (publicação impulsionada). Sem clid, só "ad" vale.
  if (!ctwaClid && sourceType !== 'ad') return null
  const sourceId = clean(referral.source_id, 40)
  return {
    metaAdId: sourceId && /^\d{5,40}$/.test(sourceId) ? sourceId : null,
    adName: clean(referral.headline, 200),
    sourceUrl: clean(referral.source_url, 500),
    ctwaClid,
  }
}
