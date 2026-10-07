export type ContactIdentifier =
  | { kind: 'leadId'; leadId: number }
  | { kind: 'phone'; raw: string; digits: string }

export function normalizeContactDigits(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/\D/g, '')
}

export function parseContactIdentifier(contact: string): ContactIdentifier {
  const trimmed = contact.trim()
  if (!trimmed) {
    throw new Error('Contato é obrigatório.')
  }

  const explicitLeadId = trimmed.match(/^lead:(.*)$/i)
  if (explicitLeadId) {
    const rawLeadId = explicitLeadId[1].trim()
    const leadId = Number(rawLeadId)
    if (/^\d+$/.test(rawLeadId) && Number.isSafeInteger(leadId) && leadId > 0) {
      return { kind: 'leadId', leadId }
    }
    throw new Error('leadId inválido: use lead:<id> com um inteiro positivo.')
  }

  const digits = normalizeContactDigits(trimmed)
  return { kind: 'phone', raw: trimmed, digits }
}

export function contactSuffixKey(companyId: number, phoneDigits: string): string | null {
  return phoneDigits.length >= 9 ? `${companyId}_${phoneDigits.slice(-9)}` : null
}

export function contactExactKey(companyId: number, phoneDigitsOrEmail: string): string {
  return `${companyId}_${phoneDigitsOrEmail}`
}

export function rememberUniqueLeadLookup(
  leadMap: Map<string, number>,
  ambiguousLeadKeys: Set<string>,
  key: string | null | undefined,
  leadId: number
) {
  if (!key) return
  if (ambiguousLeadKeys.has(key)) return
  const existing = leadMap.get(key)
  if (existing && existing !== leadId) {
    leadMap.delete(key)
    ambiguousLeadKeys.add(key)
    return
  }
  leadMap.set(key, leadId)
}

export function readUniqueLeadLookup(
  leadMap: Map<string, number>,
  ambiguousLeadKeys: Set<string>,
  key: string | null | undefined
): number | undefined {
  if (!key || ambiguousLeadKeys.has(key)) return undefined
  return leadMap.get(key)
}

export function rememberPhoneLeadLookup(
  leadMap: Map<string, number>,
  ambiguousLeadKeys: Set<string>,
  companyId: number,
  phone: string,
  leadId: number
) {
  const digits = normalizeContactDigits(phone) || phone
  if (!digits) return
  rememberUniqueLeadLookup(leadMap, ambiguousLeadKeys, contactExactKey(companyId, digits), leadId)
  rememberUniqueLeadLookup(leadMap, ambiguousLeadKeys, contactSuffixKey(companyId, digits), leadId)
}

export function resolvePhoneLeadLookup(
  leadMap: Map<string, number>,
  ambiguousLeadKeys: Set<string>,
  companyId: number,
  phone: string
): number | undefined {
  const digits = normalizeContactDigits(phone) || phone
  return (
    readUniqueLeadLookup(leadMap, ambiguousLeadKeys, contactExactKey(companyId, digits)) ||
    readUniqueLeadLookup(leadMap, ambiguousLeadKeys, contactSuffixKey(companyId, digits))
  )
}

import { db } from '@/lib/db'
import { recoveryLeads } from '@/lib/db/schema'
import { eq, and, or, sql } from 'drizzle-orm'

export type ResolvedLeadForContact = {
  lead: typeof recoveryLeads.$inferSelect | undefined
  identifier: ContactIdentifier
  ambiguous: boolean
}

export async function resolveLeadForContact(companyId: number, contact: string): Promise<ResolvedLeadForContact> {
  const identifier = parseContactIdentifier(contact)
  if (identifier.kind === 'leadId') {
    const [lead] = await db
      .select()
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.companyId, companyId), eq(recoveryLeads.id, identifier.leadId)))
      .limit(1)
    return { lead, identifier, ambiguous: false }
  }

  const exactMatches = await db
    .select()
    .from(recoveryLeads)
    .where(
      and(
        eq(recoveryLeads.companyId, companyId),
        or(
          eq(recoveryLeads.phone, identifier.raw),
          identifier.digits
            ? sql`regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g') = ${identifier.digits}`
            : undefined
        )
      )
    )
    .limit(2)

  if (exactMatches.length === 1) return { lead: exactMatches[0], identifier, ambiguous: false }
  if (exactMatches.length > 1) return { lead: undefined, identifier, ambiguous: true }

  if (identifier.digits.length >= 9) {
    const suffixMatches = await db
      .select()
      .from(recoveryLeads)
      .where(
        and(
          eq(recoveryLeads.companyId, companyId),
          sql`right(regexp_replace(${recoveryLeads.phone}, '\\D', '', 'g'), 9) = right(${identifier.digits}, 9)`
        )
      )
      .limit(2)

    if (suffixMatches.length === 1) return { lead: suffixMatches[0], identifier, ambiguous: false }
    if (suffixMatches.length > 1) return { lead: undefined, identifier, ambiguous: true }
  }

  return { lead: undefined, identifier, ambiguous: false }
}

