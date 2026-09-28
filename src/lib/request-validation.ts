export interface IntegerQueryOptions {
  defaultValue: number
  min: number
  max: number
  label: string
}

export type ParsedIntegerQuery =
  | { ok: true; value: number }
  | { ok: false; error: string }

/** Parseia inteiros sem aceitar valores parciais, decimais ou fora do intervalo. */
export function parseIntegerQuery(
  rawValue: string | null,
  options: IntegerQueryOptions,
): ParsedIntegerQuery {
  if (rawValue === null) return { ok: true, value: options.defaultValue }

  if (!/^\d+$/.test(rawValue)) {
    return { ok: false, error: `${options.label} deve ser um número inteiro entre ${options.min} e ${options.max}.` }
  }

  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value < options.min || value > options.max) {
    return { ok: false, error: `${options.label} deve ser um número inteiro entre ${options.min} e ${options.max}.` }
  }

  return { ok: true, value }
}
