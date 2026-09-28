interface HotmartTokenPayload {
  hottok?: unknown
  data?: { hottok?: unknown } | null
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Extrai o Hottok oficial e mantém os formatos legados já aceitos. */
export function extractHotmartToken(
  headers: Headers,
  body: HotmartTokenPayload,
  requestUrl: string,
): string | null {
  // Headers.get() é case-insensitive; este é o X-HOTMART-HOTTOK oficial.
  const officialHeaderToken = headers.get('x-hotmart-hottok')
  if (officialHeaderToken) return officialHeaderToken

  const legacyHeaderToken = headers.get('x-hotmart-webhook-token')
  if (legacyHeaderToken) return legacyHeaderToken

  const authHeader = headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7)

  const bodyToken = nonEmptyString(body?.hottok)
  if (bodyToken) return bodyToken

  const nestedBodyToken = nonEmptyString(body?.data?.hottok)
  if (nestedBodyToken) return nestedBodyToken

  return new URL(requestUrl).searchParams.get('hottok')
}
