
// TTL longo de 10 anos para permitir sessões permanentes ("login eterno") usadas por
// agentes autônomos, gravações de tela automatizadas e bots do servidor.
export const AGENT_SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000 // 10 anos
export const DEFAULT_AGENT_COMPANY_ID = 14

export interface AgentLoginOptions {
  companyId: number
  displayName: string
}

export function configuredMasterAgentTokens(): string[] {
  return [
    process.env.MASTER_AGENT_TOKEN?.trim(),
    process.env.PAINEL_API_TOKEN?.trim(),
    process.env.SAC_API_KEY?.trim(),
  ].filter((t): t is string => Boolean(t && t.length > 0))
}

export function configuredMasterAgentToken(): string | null {
  return configuredMasterAgentTokens()[0] || null
}

export async function isValidMasterAgentToken(token: string | null): Promise<boolean> {
  const expectedList = configuredMasterAgentTokens()
  if (!token || expectedList.length === 0) return false

  const encoder = new TextEncoder()
  const actualHash = await crypto.subtle.digest('SHA-256', encoder.encode(token))
  const actual = new Uint8Array(actualHash)

  for (const expected of expectedList) {
    const expectedHash = await crypto.subtle.digest('SHA-256', encoder.encode(expected))
    const wanted = new Uint8Array(expectedHash)
    if (actual.length === wanted.length) {
      let difference = 0
      for (let index = 0; index < wanted.length; index += 1) difference |= actual[index] ^ wanted[index]
      if (difference === 0) return true
    }
  }

  return false
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
