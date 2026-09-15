import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, settings, agentActivityLogs } from '@/lib/db/schema'
import { eq, or, sql } from 'drizzle-orm'
import { getCurrentCompany, checkIsAdmin } from '@/lib/auth'

export type AgentIdentifier = 'bia' | 'luana' | 'renato' | 'master' | 'admin' | 'humano'
export type AgentDisplayName = 'Bia' | 'Luana' | 'Renato' | 'Master' | 'Administrador' | 'Humano'

export interface AgentAuthContext {
  company: typeof companies.$inferSelect
  isAdmin: boolean
  isAgentApiKey: boolean
  agentId: AgentIdentifier
  agentName: AgentDisplayName
  managerName?: 'Amanda' | 'Gastão' | null
}

export function getAgentManager(agent: string | null | undefined): 'Amanda' | 'Gastão' | null {
  if (!agent) return null
  const lower = agent.toLowerCase()
  if (lower.includes('bia')) return 'Amanda'
  if (lower.includes('luana')) return 'Gastão'
  return null
}

const DEFAULT_MASTER_KEY = process.env.SAC_API_KEY || 'sac_master_api_key_2026'
const DEFAULT_BIA_KEY = process.env.SAC_AGENT_BIA_KEY || 'sac_agent_bia_live_2026'
const DEFAULT_LUANA_KEY = process.env.SAC_AGENT_LUANA_KEY || 'sac_agent_luana_live_2026'
const DEFAULT_RENATO_KEY = process.env.SAC_AGENT_RENATO_KEY || 'sac_agent_renato_live_2026'

/**
 * Registra uma atividade no log de auditoria
 */
export async function logAgentActivity(params: {
  companyId: number
  agentName: string
  agentId?: string
  action: string
  entityType: string
  entityId?: string | null
  details?: Record<string, any>
}) {
  try {
    await db.insert(agentActivityLogs).values({
      companyId: params.companyId,
      agentName: params.agentName,
      agentId: params.agentId || null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ? String(params.entityId) : null,
      details: params.details || null,
    })
  } catch (err) {
    console.error('[logAgentActivity Error]', err)
  }
}

/**
 * Autentica uma requisição de Agente IA (Bearer token ou x-api-key),
 * identifica se é Bia (Amanda) ou Luana (Gastão), e valida a Allowlist de IPs se configurada.
 */
export async function authenticateAgentRequest(
  req: NextRequest,
  companyIdOrSlug?: string
): Promise<{ error?: NextResponse; context?: AgentAuthContext }> {
  const authHeader = req.headers.get('authorization')
  const apiKeyHeader = req.headers.get('x-api-key')
  const companyHeader = req.headers.get('x-company-slug') || req.headers.get('x-company-id')
  const agentHeader = req.headers.get('x-agent-id') || req.headers.get('x-agent-name')

  let providedKey: string | null = null
  if (authHeader && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7).trim()
  } else if (apiKeyHeader) {
    providedKey = apiKeyHeader.trim()
  }

  let isAgentApiKey = false
  let isAdmin = false
  let agentId: AgentIdentifier = 'master'
  let agentName: AgentDisplayName = 'Master'

  // 1. Identificação de Bia ou Luana pela Chave de API ou Header
  if (providedKey) {
    isAgentApiKey = true

    if (
      providedKey === DEFAULT_BIA_KEY ||
      providedKey.toLowerCase().includes('bia') ||
      agentHeader?.toLowerCase().includes('bia')
    ) {
      agentId = 'bia'
      agentName = 'Bia'
      isAdmin = true
    } else if (
      providedKey === DEFAULT_LUANA_KEY ||
      providedKey.toLowerCase().includes('luana') ||
      agentHeader?.toLowerCase().includes('luana')
    ) {
      agentId = 'luana'
      agentName = 'Luana'
      isAdmin = true
    } else if (
      providedKey === DEFAULT_RENATO_KEY ||
      providedKey.toLowerCase().includes('renato') ||
      agentHeader?.toLowerCase().includes('renato')
    ) {
      agentId = 'bia'
      agentName = 'Bia'
      isAdmin = true
    } else if (
      providedKey === DEFAULT_MASTER_KEY ||
      (process.env.SAC_API_KEY && providedKey === process.env.SAC_API_KEY)
    ) {
      isAdmin = true
      // Verifica se enviou header especificando Bia ou Luana
      if (agentHeader?.toLowerCase().includes('bia')) {
        agentId = 'bia'
        agentName = 'Bia'
      } else if (agentHeader?.toLowerCase().includes('luana')) {
        agentId = 'luana'
        agentName = 'Luana'
      } else {
        agentId = 'master'
        agentName = 'Master'
      }
    } else {
      // Verifica no banco se é a chave de Bia ou Luana de alguma empresa ou inviteToken
      const [compSettings] = await db
        .select({
          company: companies,
          settings: settings,
        })
        .from(companies)
        .leftJoin(settings, eq(settings.companyId, companies.id))
        .where(
          or(
            eq(settings.agentBiaApiKey, providedKey),
            eq(settings.agentLuanaApiKey, providedKey),
            eq(settings.agentRenatoApiKey, providedKey),
            eq(companies.inviteToken, providedKey)
          )
        )
        .limit(1)

      if (compSettings) {
        if (compSettings.settings?.agentBiaApiKey === providedKey) {
          agentId = 'bia'
          agentName = 'Bia'
        } else if (compSettings.settings?.agentLuanaApiKey === providedKey) {
          agentId = 'luana'
          agentName = 'Luana'
        } else if (compSettings.settings?.agentRenatoApiKey === providedKey) {
          agentId = 'bia'
          agentName = 'Bia'
        }
        return {
          context: {
            company: compSettings.company,
            isAdmin: true,
            isAgentApiKey: true,
            agentId,
            agentName,
            managerName: getAgentManager(agentName),
          },
        }
      }

      return {
        error: NextResponse.json(
          {
            error: 'Chave de API inválida ou não autorizada para o agente.',
            code: 'INVALID_API_KEY',
          },
          { status: 401 }
        ),
      }
    }
  }

  // 2. Resolução da Empresa
  const target = companyIdOrSlug || companyHeader
  let targetCompany: typeof companies.$inferSelect | null = null

  if (target) {
    const isNum = !isNaN(parseInt(target)) && /^\d+$/.test(target)
    const [found] = await db
      .select()
      .from(companies)
      .where(isNum ? eq(companies.id, parseInt(target)) : eq(companies.slug, target))
      .limit(1)

    targetCompany = found ?? null
  }

  // 3. Se for sessão de navegador e não tiver API Key, usa a empresa da sessão
  if (!targetCompany && !isAgentApiKey) {
    try {
      targetCompany = await getCurrentCompany()
      agentId = 'admin'
      agentName = 'Administrador'
    } catch {
      // Ignora
    }
  }

  // Fallback: se for Master Key e nenhuma empresa foi especificada, pega a primeira ativa
  if (!targetCompany && isAgentApiKey) {
    const [first] = await db.select().from(companies).limit(1)
    targetCompany = first ?? null
  }

  if (!targetCompany) {
    if (isAgentApiKey) {
      return {
        error: NextResponse.json(
          { error: `Empresa "${target || 'padrão'}" não encontrada`, code: 'COMPANY_NOT_FOUND' },
          { status: 404 }
        ),
      }
    }
    return {
      error: NextResponse.json(
        {
          error:
            'Autenticação necessária. Envie Authorization: Bearer <SAC_API_KEY> ou faça login.',
          code: 'UNAUTHORIZED',
        },
        { status: 401 }
      ),
    }
  }

  // 4. Verificação de Allowlist de IPs (se configurada na empresa)
  if (isAgentApiKey) {
    const [compSet] = await db
      .select()
      .from(settings)
      .where(eq(settings.companyId, targetCompany.id))
      .limit(1)

    if (compSet?.allowedIps && compSet.allowedIps.trim().length > 0) {
      const allowedList = compSet.allowedIps
        .split(',')
        .map((ip) => ip.trim())
        .filter(Boolean)

      const clientIp =
        req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
        req.headers.get('x-real-ip') ||
        '127.0.0.1'

      const isAllowed =
        allowedList.includes(clientIp) ||
        allowedList.includes('*') ||
        clientIp === '127.0.0.1' ||
        clientIp === '::1'

      if (!isAllowed) {
        return {
          error: NextResponse.json(
            {
              error: `Acesso bloqueado: IP de origem (${clientIp}) não consta na lista de IPs autorizados.`,
              code: 'IP_NOT_ALLOWED',
            },
            { status: 403 }
          ),
        }
      }
    }
  }

  return {
    context: {
      company: targetCompany,
      isAdmin,
      isAgentApiKey,
      agentId,
      agentName,
    },
  }
}

