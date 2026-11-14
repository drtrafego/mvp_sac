import 'server-only'

import { cookies } from 'next/headers'
import { eq } from 'drizzle-orm'
import { requireCompanyRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { operatorCompanyIsAvailable } from './policy'
import { sacOperatorCompanySettings } from './schema'

export class OperatorAccessError extends Error {
  constructor(message: string, readonly status = 403) { super(message) }
}

function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as { code?: unknown; cause?: unknown }
  return typeof record.code === 'string' ? record.code : postgresCode(record.cause)
}

// A rota pode subir antes da migration. Falhar fechado evita expor SQL e evita
// qualquer job quando as tabelas próprias do operador ainda não existem.
export function isOperatorTableMissing(error: unknown) { return postgresCode(error) === '42P01' }

export type OperatorAdmin = {
  company: { id: number; slug: string; name: string }
  user: { id: string; displayName?: string | null; primaryEmail?: string | null }
  role: string
  settings: typeof sacOperatorCompanySettings.$inferSelect
}

// Esta rota aceita apenas sessão humana do painel. Uma sessão de agente é
// deliberadamente recusada antes de usar os helpers legados de autenticação.
export async function requireOperatorAdmin(): Promise<OperatorAdmin> {
  const store = await cookies()
  if (store.has('agent_auth_session')) throw new OperatorAccessError('Sessões de agente não podem usar o Operador SAC.', 401)
  const access = await requireCompanyRole('admin')
  let settings: typeof sacOperatorCompanySettings.$inferSelect | undefined
  try {
    [settings] = await db.select().from(sacOperatorCompanySettings)
      .where(eq(sacOperatorCompanySettings.companyId, access.company.id)).limit(1)
  } catch (error) {
    if (isOperatorTableMissing(error)) throw new OperatorAccessError('Operador desligado para esta empresa.')
    console.error('[Operador SAC] falha ao verificar disponibilidade', { code: postgresCode(error) ?? 'desconhecido' })
    throw new OperatorAccessError('Operador indisponível para esta empresa.', 503)
  }
  if (!settings?.enabled) throw new OperatorAccessError('O Operador SAC está desligado para esta empresa.')
  if (!operatorCompanyIsAvailable(settings)) throw new OperatorAccessError('O kill switch do Operador SAC está ativo.')
  return { company: access.company, user: access.user, role: access.role, settings }
}
