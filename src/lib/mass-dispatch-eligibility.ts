export type DispatchEligibilityRow = { id: number; phone: string | null }

export type DispatchEligibility = {
  requestedCount: number
  uniqueRequestedCount: number
  duplicateCount: number
  eligibleCount: number
  missingCount: number
  noPhoneCount: number
}

/** Summarizes a selection without returning contact data. */
export function summarizeDispatchEligibility(requestedIds: number[], rows: DispatchEligibilityRow[]): DispatchEligibility {
  const uniqueIds = [...new Set(requestedIds)]
  const knownIds = new Set(rows.map(row => row.id))
  const missingCount = uniqueIds.filter(id => !knownIds.has(id)).length
  const noPhoneCount = rows.filter(row => !row.phone?.trim()).length
  return {
    requestedCount: requestedIds.length,
    uniqueRequestedCount: uniqueIds.length,
    duplicateCount: requestedIds.length - uniqueIds.length,
    eligibleCount: rows.length - noPhoneCount,
    missingCount,
    noPhoneCount,
  }
}
