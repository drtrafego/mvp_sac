import { createHmac, timingSafeEqual } from 'crypto'

/**
 * Valida a assinatura x-hub-signature-256 da Meta usando META_APP_SECRET ou segredo customizado
 */
export function verifyMetaSignature(rawBody: string, signatureHeader: string | null, customSecret?: string | null): boolean {
  const secret = customSecret || process.env.META_APP_SECRET || process.env.INSTAGRAM_APP_SECRET
  if (!secret || !signatureHeader) return false

  try {
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex')
    const a = Buffer.from(expected)
    const b = Buffer.from(signatureHeader)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch (err) {
    console.error('[Meta Signature] Erro ao validar assinatura:', err)
    return false
  }
}
