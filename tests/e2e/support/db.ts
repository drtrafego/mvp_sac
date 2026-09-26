// Copiado SOMENTE para a aplicação temporária. Nenhum driver de produção muda.
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '@/lib/db/schema'

const url = new URL(process.env.DATABASE_URL || '')
if (process.env.SAC_E2E !== '1' || url.hostname !== '127.0.0.1' || url.pathname !== '/sac_e2e') {
  throw new Error('E2E recusou banco não descartável/local')
}
const client = postgres(url.toString(), { max: 5 })
export const db = drizzle(client, { schema })
