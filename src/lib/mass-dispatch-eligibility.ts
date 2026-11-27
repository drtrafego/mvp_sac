import { formatBrazilianPhone } from '@/lib/phone'

export type DispatchEligibilityRow = {
  id: number
  phone: string | null
  whatsappConsentStatus?: string | null
}

export type DispatchEligibility = {
  requestedCount: number
  uniqueRequestedCount: number
  duplicateCount: number
  eligibleCount: number
  missingCount: number
  noPhoneCount: number
  consentBlockedCount?: number
  duplicatePhoneCount?: number
}

export type DispatchSelectionSummary = DispatchEligibility & {
  consentBlockedCount: number
  duplicatePhoneCount: number
}

export function hasDispatchPhone(row: DispatchEligibilityRow): boolean {
  return Boolean(row.phone?.trim())
}

/** Seleciona deterministicamente um telefone único com consentimento explícito. */
export function selectUniqueOptedInDispatchRows<T extends DispatchEligibilityRow>(rows: T[]): T[] {
  const seenPhones = new Set<string>()
  return [...rows]
    .sort((a, b) => a.id - b.id)
    .filter(row => {
      if (!hasDispatchPhone(row) || row.whatsappConsentStatus !== 'opted_in') return false
      const phone = formatBrazilianPhone(row.phone)
      if (!phone || seenPhones.has(phone)) return false
      seenPhones.add(phone)
      return true
    })
}

export function summarizeDispatchSelection<T extends DispatchEligibilityRow>(requestedIds: number[], rows: T[]): DispatchSelectionSummary {
  const base = summarizeDispatchEligibility(requestedIds, rows)
  const rowsWithPhone = rows.filter(hasDispatchPhone)
  const optedInRows = rowsWithPhone.filter(row => row.whatsappConsentStatus === 'opted_in')
  const selected = selectUniqueOptedInDispatchRows(rows)
  const phoneCounts = new Map<string, number>()
  for (const row of optedInRows) {
    const phone = formatBrazilianPhone(row.phone)
    if (phone) phoneCounts.set(phone, (phoneCounts.get(phone) ?? 0) + 1)
  }
  const duplicatePhoneCount = [...phoneCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0)
  return {
    ...base,
    eligibleCount: selected.length,
    consentBlockedCount: rowsWithPhone.filter(row => row.whatsappConsentStatus !== 'opted_in').length,
    duplicatePhoneCount,
  }
}

/** Summarizes a selection without returning contact data. */
export function summarizeDispatchEligibility(requestedIds: number[], rows: DispatchEligibilityRow[]): DispatchEligibility {
  const uniqueIds = [...new Set(requestedIds)]
  const knownIds = new Set(rows.map(row => row.id))
  const missingCount = uniqueIds.filter(id => !knownIds.has(id)).length
  const noPhoneCount = rows.filter(row => !hasDispatchPhone(row)).length
  return {
    requestedCount: requestedIds.length,
    uniqueRequestedCount: uniqueIds.length,
    duplicateCount: requestedIds.length - uniqueIds.length,
    eligibleCount: rows.filter(hasDispatchPhone).length,
    missingCount,
    noPhoneCount,
  }
}
