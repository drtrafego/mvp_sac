export interface ProductScopedSequence {
  productFilter?: string | null
}

// Regra canônica usada pelos webhooks e pelo disparo em massa: uma sequência
// específica para produto ganha da sequência genérica; filtro aceita tanto o
// id quanto o nome do produto.
export function selectRecoverySequence<T extends ProductScopedSequence>(
  sequences: T[],
  productId: string | null | undefined,
  productName: string | null | undefined,
): T | null {
  return sequences.find(sequence =>
    Boolean(sequence.productFilter)
      && (sequence.productFilter === productId || sequence.productFilter === productName)
  ) ?? sequences.find(sequence => !sequence.productFilter) ?? null
}

export function sequenceMatchesProduct(
  productFilter: string | null | undefined,
  productId: string | null | undefined,
  productName: string | null | undefined,
): boolean {
  return selectRecoverySequence([{ productFilter }], productId, productName) !== null
}
