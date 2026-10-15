
export const AGENT_SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const DEFAULT_AGENT_COMPANY_ID = 14

export interface AgentLoginOptions {
  companyId: number
  displayName: string
}

export function configuredMasterAgentToken(): string | null {
  return process.env.MASTER_AGENT_TOKEN?.trim() || null
}

export async function isValidMasterAgentToken(token: string | null): Promise<boolean> {
  const expected = configuredMasterAgentToken()
  if (!token || !expected) return false

  const encoder = new TextEncoder()
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(token)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const actual = new Uint8Array(actualHash)
  const wanted = new Uint8Array(expectedHash)
  let difference = 0
  for (let index = 0; index < wanted.length; index += 1) difference |= actual[index] ^ wanted[index]
  return difference === 0
}

function parseCompanyId(value: string | null): number {
  if (!value || !/^[1-9]\d{0,8}$/.test(value)) return DEFAULT_AGENT_COMPANY_ID
  const companyId = Number(value)
  return Number.isSafeInteger(companyId) ? companyId : DEFAULT_AGENT_COMPANY_ID
}

function parseDisplayName(value: string | null): string {
  if (!value) return 'Agente IA (Admin)'
  const normalized = value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 80)
  return normalized || 'Agente IA (Admin)'
}

export function parseAgentLoginOptions(searchParams: URLSearchParams): AgentLoginOptions {
  return {
    companyId: parseCompanyId(searchParams.get('company_id')),
    displayName: parseDisplayName(searchParams.get('name')),
  }
}
