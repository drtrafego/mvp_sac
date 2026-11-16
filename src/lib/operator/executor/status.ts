import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { varrer } from './queue'
import type { ExecutorStatus } from './contract'

export async function executorStatus(companyId: number): Promise<ExecutorStatus> {
  await varrer(companyId)
  const { rows } = await db.execute<{ disponivel: boolean; ultimo_contato_em: string | null; motivo: string | null }>(sql`
    SELECT (ultimo_contato_em > now() - interval '40 seconds' AND estado_informado = 'pronto') AS disponivel, ultimo_contato_em, motivo
    FROM sac_operator_executors WHERE revogado_em IS NULL AND empresas_permitidas @> jsonb_build_array(${companyId}::int)
    ORDER BY (ultimo_contato_em > now() - interval '40 seconds' AND estado_informado = 'pronto') DESC NULLS LAST, ultimo_contato_em DESC NULLS LAST LIMIT 1`)
  const row = rows[0]
  return { disponivel: row?.disponivel === true, ultimoContatoEm: row?.ultimo_contato_em ? new Date(row.ultimo_contato_em).toISOString() : null, motivo: row?.motivo ?? null }
}
