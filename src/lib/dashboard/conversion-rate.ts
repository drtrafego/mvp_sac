export type ConversionRate = {
  numerator: number
  denominator: number
  percentage: number | null
  label: string
}

/**
 * A conversion rate has no numeric value when there is no denominator.
 * The numerator is capped to keep a percentage meaningful if upstream data
 * contains duplicate or late-arriving events.
 */
export function calculateConversionRate(numerator: number, denominator: number): ConversionRate {
  const safeDenominator = Number.isFinite(denominator) ? Math.max(0, denominator) : 0
  if (safeDenominator === 0) {
    return { numerator: 0, denominator: 0, percentage: null, label: 'Sem dados' }
  }

  const safeNumerator = Number.isFinite(numerator)
    ? Math.min(safeDenominator, Math.max(0, numerator))
    : 0
  const percentage = (safeNumerator / safeDenominator) * 100
  return {
    numerator: safeNumerator,
    denominator: safeDenominator,
    percentage,
    label: `${percentage.toFixed(1)}%`,
  }
}
