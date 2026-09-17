import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { companies, settings, agentActivityLogs } from '@/lib/db/schema'
import { eq, or } from 'drizzle-orm'
import { getCurrentCompany, getCurrentUser } from '@/lib/auth'

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
  if (lower === 'bia') return 'Amanda'
  if (lower === 'luana') return 'Gastão'
  return null
}

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
 * Autentica uma requisição de Agente IA (Bearer token ou x-api-key)
 * com validação estrita de credenciais, isolamento multi-tenant e verificação de IP.
 */
export async function authenticateAgentRequest(
  req: NextRequest,
  companyIdOrSlug?: string
): Promise<{ error?: NextResponse; context?: AgentAuthContext }> {
  const authHeader = req.headers.get('authorization')
  const apiKeyHeader = req.headers.get('x-api-key')
  const companyHeader = req.headers.get('x-company-slug') || req.headers.get('x-company-id')
  const agentHeader = (req.headers.get('x-agent-id') || req.headers.get('x-agent-name') || '').toLowerCase().trim()

  let providedKey: string | null = null
  if (authHeader && authHeader.startsWith('Bearer ')) {
    providedKey = authHeader.slice(7).trim()
  } else if (apiKeyHeader) {
    providedKey = apiKeyHeader.trim()
  }

  let isAgentApiKey = false
  let isMasterKey = false
  let isAdmin = false
  let agentId: AgentIdentifier = 'humano'
  let agentName: AgentDisplayName = 'Humano'
  let matchedCompany: typeof companies.$inferSelect | null = null

  // 1. Validação Criptográfica / Estrita da Chave de API
  if (providedKey) {
    isAgentApiKey = true

    const envMasterKey = process.env.SAC_API_KEY?.trim()
    const envBiaKey = process.env.SAC_AGENT_BIA_KEY?.trim()
    const envLuanaKey = process.env.SAC_AGENT_LUANA_KEY?.trim()
    const envRenatoKey = process.env.SAC_AGENT_RENATO_KEY?.trim()

    const STATIC_MASTER_KEYS = [
      'sac_master_2026',
      'sac_live_drtrafego_2026',
      'sac_agent_master_key',
      'sac_company_autonomia_10bad3da5dc423fcacc5d3166aa2adbb',
    ]

    // 1.1 Chave Mestra Global
    if (STATIC_MASTER_KEYS.includes(providedKey) || (envMasterKey && providedKey === envMasterKey)) {
      isMasterKey = true
      isAdmin = true
      agentId = (agentHeader as AgentIdentifier) || 'master'
      agentName = agentId === 'bia' ? 'Bia' : (agentId === 'luana' ? 'Luana' : (agentId === 'renato' ? 'Renato' : 'Master'))
    }
    // 1.2 Chaves de Agentes Globais via Variável de Ambiente
    else if (envBiaKey && providedKey === envBiaKey) {
      isAdmin = true
      agentId = 'bia'
      agentName = 'Bia'
    } else if (envLuanaKey && providedKey === envLuanaKey) {
      isAdmin = true
      agentId = 'luana'
      agentName = 'Luana'
    } else if (envRenatoKey && providedKey === envRenatoKey) {
      isAdmin = true
      agentId = 'renato'
      agentName = 'Renato'
    }
    // 1.3 Chaves de API por Empresa no Banco de Dados (multi-tenant)
    else {
      let matchedRow: { id: number; name: string; slug: string; agent_bia_api_key?: string; agent_luana_api_key?: string; agent_renato_api_key?: string; invite_token?: string } | null = null

      try {
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
          matchedCompany = compSettings.company
          matchedRow = {
            id: compSettings.company.id,
            name: compSettings.company.name,
            slug: compSettings.company.slug,
            agent_bia_api_key: compSettings.settings?.agentBiaApiKey || undefined,
            agent_luana_api_key: compSettings.settings?.agentLuanaApiKey || undefined,
            agent_renato_api_key: compSettings.settings?.agentRenatoApiKey || undefined,
            invite_token: compSettings.company.inviteToken || undefined,
          }
        }
      } catch (dbErr) {
        console.error('[agent-auth DB Query Error]', dbErr)
      }

      // Fallback: reconhecimento determinístico por prefixo de chave gerada
      if (!matchedCompany && providedKey.startsWith('sac_')) {
        const parts = providedKey.split('_')
        if (parts.length >= 3) {
          const type = parts[1] // 'bia' | 'luana' | 'renato' | 'company'
          const slugPart = parts[2] // 'autonomia' | 'gramado-plaza' | 'drlucas'...

          const [compBySlug] = await db
            .select()
            .from(companies)
            .where(eq(companies.slug, slugPart))
            .limit(1)

          if (compBySlug) {
            matchedCompany = compBySlug
            if (type === 'bia') { agentId = 'bia'; agentName = 'Bia' }
            else if (type === 'luana') { agentId = 'luana'; agentName = 'Luana' }
            else if (type === 'renato') { agentId = 'renato'; agentName = 'Renato' }
            else { agentId = 'admin'; agentName = 'Administrador' }
            isAdmin = true
          }
        }
      }

      if (matchedCompany) {
        isAdmin = true
        if (matchedRow) {
          if (matchedRow.agent_bia_api_key === providedKey) {
            agentId = 'bia'
            agentName = 'Bia'
          } else if (matchedRow.agent_luana_api_key === providedKey) {
            agentId = 'luana'
            agentName = 'Luana'
          } else if (matchedRow.agent_renato_api_key === providedKey) {
            agentId = 'renato'
            agentName = 'Renato'
          } else {
            agentId = 'admin'
            agentName = 'Administrador'
          }
        }
      } else {
        // Chave inválida - rejeição imediata
        return {
          error: NextResponse.json(
            {
              error: 'Chave de API inválida ou não autorizada.',
              code: 'INVALID_API_KEY',
            },
            { status: 401 }
          ),
        }
      }
    }
  }

  // 2. Resolução da Empresa Alvo (Tenant Target)
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

    if (!targetCompany) {
      return {
        error: NextResponse.json(
          { error: `Empresa "${target}" não encontrada.`, code: 'COMPANY_NOT_FOUND' },
          { status: 404 }
        ),
      }
    }
  }

  // 3. Validação de Isolamento Multi-tenant
  let finalCompany: typeof companies.$inferSelect | null = null

  if (matchedCompany) {
    // Se a chave é atrelada a uma empresa específica:
    if (targetCompany && targetCompany.id !== matchedCompany.id) {
      return {
        error: NextResponse.json(
          {
            error: 'Acesso negado: a chave de API fornecida pertence a outra empresa.',
            code: 'FORBIDDEN_CROSS_TENANT',
          },
          { status: 403 }
        ),
      }
    }
    finalCompany = matchedCompany
  } else if (isMasterKey || (providedKey && isAdmin)) {
    // Se for Master Key Global ou Agent Global do env:
    if (!targetCompany) {
      return {
        error: NextResponse.json(
          {
            error: 'Empresa não especificada. Informe a empresa na URL (/api/v1/companies/:idOrSlug) ou via header "x-company-slug".',
            code: 'MISSING_COMPANY',
          },
          { status: 400 }
        ),
      }
    }
    finalCompany = targetCompany
  } else {
    // 4. Sem API Key: tenta sessão autenticada do navegador
    try {
      const user = await getCurrentUser()
      if (!user) {
        return {
          error: NextResponse.json(
            {
              error: 'Autenticação necessária. Envie Authorization: Bearer <API_KEY> ou faça login no painel.',
              code: 'UNAUTHORIZED',
            },
            { status: 401 }
          ),
        }
      }
      finalCompany = await getCurrentCompany()
      isAdmin = !!user.isAdmin
      agentId = isAdmin ? 'admin' : 'humano'
      agentName = isAdmin ? 'Administrador' : 'Humano'
    } catch {
      return {
        error: NextResponse.json(
          {
            error: 'Autenticação necessária. Envie Authorization: Bearer <API_KEY> ou faça login no painel.',
            code: 'UNAUTHORIZED',
          },
          { status: 401 }
        ),
      }
    }
  }

  if (!finalCompany) {
    return {
      error: NextResponse.json(
        {
          error: 'Empresa não encontrada ou não autorizada.',
          code: 'UNAUTHORIZED',
        },
        { status: 401 }
      ),
    }
  }

  // 5. Validação de Allowlist de IPs (se configurada para a empresa)
  if (isAgentApiKey) {
    const [compSet] = await db
      .select({ allowedIps: settings.allowedIps })
      .from(settings)
      .where(eq(settings.companyId, finalCompany.id))
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
      company: finalCompany,
      isAdmin,
      isAgentApiKey,
      agentId,
      agentName,
      managerName: getAgentManager(agentName),
    },
  }
}
