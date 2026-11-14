import { sql } from 'drizzle-orm'
import { OperatorServiceError } from '../service'
import { isOperatorTableMissing } from '../panel-auth'
import { db } from '@/lib/db'
export async function adquirirTrava(companyId: number, holder: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await db.execute(sql`INSERT INTO sac_operator_locks (company_id, holder, locked_until, updated_at)
      VALUES (${companyId}, ${holder}::uuid, now() + interval '60 seconds', now())
      ON CONFLICT (company_id) DO UPDATE SET holder = EXCLUDED.holder, locked_until = EXCLUDED.locked_until, updated_at = now()
      WHERE sac_operator_locks.locked_until < now() OR sac_operator_locks.holder = EXCLUDED.holder RETURNING holder`)
    if (result.rows.length) return true
    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}
export async function liberarTrava(companyId: number, holder: string): Promise<void> {
  await db.execute(sql`DELETE FROM sac_operator_locks WHERE company_id = ${companyId} AND holder = ${holder}::uuid`)
}

export async function verificarTabelaTrava() {
  try { await db.execute(sql`SELECT company_id FROM sac_operator_locks WHERE false`) }
  catch (error) {
    if (isOperatorTableMissing(error)) throw new OperatorServiceError('Operador desligado: a migração de regras ainda não foi aplicada.', 403, 'DISABLED')
    throw error
  }
}
